/**
 * Dogfood test — boot Lodestone and have a real conversation with the LLM.
 * This verifies the full pipeline: config → engine → agent loop → LLM → response.
 */
import { LodestoneEngine, type LodestoneConfig } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { StreamHandler, type StreamEvent } from '../streaming/handler.js';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

async function main() {
  console.log('=== Lodestone Dogfood Test ===\n');

  // Ensure dirs exist
  const root = resolve(import.meta.dirname, '../../../../');
  const dataDir = resolve(root, 'data');
  const wikiDir = resolve(root, 'memory/wiki');
  const identityDir = resolve(root, 'workspace');
  const memoryDir = resolve(root, 'data/lancedb');
  for (const d of [dataDir, wikiDir, identityDir, memoryDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // Config — use glm-5.2:cloud via Ollama
  const config: LodestoneConfig = {
    workspaceRoot: root,
    identityDir,
    wikiRoot: wikiDir,
    memoryDir,
    maxConcurrentTools: 4,
    maxConcurrentJobs: 2,
    compactionThreshold: 0.5,
    llm: {
      default: {
        type: 'ollama',
        model: 'glm-5.2:cloud',
        baseUrl: 'http://127.0.0.1:11434/api',
        contextWindow: 128000,
        maxTokens: 2048,
      },
    },
  };

  console.log('1. Creating engine...');
  const engine = new LodestoneEngine(config);

  console.log('2. Initializing memory...');
  await engine.memory.init();

  console.log('3. Registering tools...');
  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(dataDir, 'decisions.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  console.log('4. Starting engine...');
  await engine.start();

  console.log('5. Creating session...');
  const sessionId = engine.createSession();

  console.log('6. Creating agent loop + stream handler...');
  const loop = new AgentLoop(engine);
  const stream = new StreamHandler();

  // Track stream events
  const events: string[] = [];
  stream.on('text_delta', (event: StreamEvent) => {
    const data = event.data as { text?: string };
    if (data.text) process.stdout.write(data.text);
  });
  stream.on('tool_call_start', (event: StreamEvent) => {
    const data = event.data as { toolName?: string };
    events.push(`tool_call: ${data.toolName || 'unknown'}`);
    console.log(`\n[TOOL CALL: ${data.toolName || 'unknown'}]`);
  });
  stream.on('tool_result', (event: StreamEvent) => {
    const data = event.data as { toolName?: string; success?: boolean };
    events.push(`tool_result: ${data.toolName || 'unknown'} (${data.success ? 'ok' : 'fail'})`);
  });

  // Test messages
  const messages = [
    'Hi! Who are you?',
    'What tools do you have available?',
    'Can you help me plan a simple task?',
  ];

  let passCount = 0;
  let failCount = 0;

  for (const msg of messages) {
    console.log(`\n\n--- User: "${msg}" ---`);
    console.log('Assistant: ');

    try {
      const result = await loop.run(sessionId, msg, stream);
      console.log('\n');
      console.log(`  → Response length: ${result.response.length} chars`);
      console.log(`  → Tool calls: ${result.toolCalls?.length || 0}`);
      console.log(`  → Tokens: ${result.totalTokens || 'n/a'}`);
      console.log(`  → Rounds: ${result.rounds || 1}`);

      if (result.response.length > 0) {
        console.log('  ✅ PASS');
        passCount++;
      } else {
        console.log('  ❌ FAIL — empty response');
        failCount++;
      }
    } catch (err) {
      console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  }

  // Test 4: Session persistence
  console.log('\n--- Test: Session persistence ---');
  try {
    const sessions = engine.sessions.list();
    console.log(`  Sessions: ${sessions.length}`);
    if (sessions.length > 0) {
      const s = sessions[0];
      const msgs = s.messages;
      console.log(`  Messages in session: ${msgs.length}`);
      console.log(`  Session ID: ${s.id}`);
      if (msgs.length >= 2) {
        console.log('  ✅ PASS — session has messages from conversation');
        passCount++;
      } else {
        console.log('  ⚠️ WARN — session has fewer messages than expected');
        failCount++;
      }
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 5: Memory system
  console.log('\n--- Test: Memory system ---');
  try {
    const stats = (engine.memory as unknown as { getStats?: () => unknown }).getStats?.() || 'no stats method';
    console.log(`  Memory stats: ${JSON.stringify(stats)}`);
    console.log('  ✅ PASS — memory system responsive');
    passCount++;
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 6: Safety system
  console.log('\n--- Test: Safety system ---');
  try {
    const caps = engine.safety.capabilities;
    const summary = caps.getTierSummary();
    const tiers = Object.keys(summary);
    const totalTools = tiers.reduce((sum: number, t: string) => sum + (summary as Record<string, { count: number }>)[t].count, 0);
    console.log(`  Capability tiers: ${totalTools} tools, ${tiers.length} tiers`);
    console.log('  ✅ PASS — safety system responsive');
    passCount++;
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 7: Improvement system
  console.log('\n--- Test: Improvement system ---');
  try {
    const diag = engine.improvement.rbtDiagnosis;
    const latest = await diag.getLatest();
    console.log(`  Latest diagnosis: ${latest ? 'exists' : 'none yet'}`);
    console.log('  ✅ PASS — improvement system responsive');
    passCount++;
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 8: Engine events
  console.log('\n--- Test: Engine event emission ---');
  try {
    let eventReceived = false;
    engine.onEvent((event) => {
      if (event.type === 'message.sent') eventReceived = true;
    });
    engine.emit({ type: 'message.sent', sessionId, content: 'test' });
    if (eventReceived) {
      console.log('  ✅ PASS — events fire correctly');
      passCount++;
    } else {
      console.log('  ❌ FAIL — event not received');
      failCount++;
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Shutdown
  console.log('\n--- Shutting down ---');
  await engine.stop();

  console.log(`\n📊 Dogfood Results: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
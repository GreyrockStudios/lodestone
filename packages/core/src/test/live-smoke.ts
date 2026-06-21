#!/usr/bin/env node

/**
 * Lodestone — Live Smoke Test (non-interactive)
 *
 * Boots the engine, connects to Ollama, sends one message, captures the response.
 * This proves the full pipeline: identity → system prompt → LLM → response.
 */

import { LodestoneEngine } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool } from '../tools/impl/wiki-resolve.js';
import { WikiSearchTool } from '../tools/impl/wiki-search.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { resolve } from 'path';

const WORKSPACE = '/tmp/lodestone-test/workspace';

async function main() {
  console.log('');
  console.log('🔮 Lodestone — Live Smoke Test');
  console.log('═'.repeat(50));

  // 1. Boot engine
  console.log('\n[1/7] Creating engine...');
  const engine = new LodestoneEngine({
    workspaceRoot: WORKSPACE,
    identityDir: WORKSPACE,
    wikiRoot: resolve(WORKSPACE, 'memory/wiki'),
    memoryDir: resolve(WORKSPACE, 'data/lancedb'),
    llm: {
      default: {
        type: 'ollama',
        model: 'glm-5.2:cloud',
        baseUrl: 'http://127.0.0.1:11434/api',
        contextWindow: 32768,
        maxTokens: 2048,
      },
    },
  });

  // 2. Initialize memory
  console.log('[2/7] Initializing memory...');
  await engine.memory.init();

  // 3. Register tools
  console.log('[3/7] Registering tools...');
  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new WikiSearchTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(WORKSPACE, 'data/decisions.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  // 4. Load identity
  console.log('[4/7] Loading identity...');
  const identity = await engine.identity.load();
  console.log(`   → Name: ${identity.identity.name}`);
  console.log(`   → System prompt length: ${identity.systemPrompt.length} chars`);

  // 5. Create session
  console.log('[5/7] Creating session...');
  const sessionId = engine.createSession();

  // 6. Create agent loop
  console.log('[6/7] Creating agent loop...');
  const loop = new AgentLoop(engine, {
    maxToolRounds: 5,
    maxTokens: 2048,
    temperature: 0.7,
    stream: false,
    autoCapture: true,
    autoRecall: true,
  });

  // 7. Send a test message
  console.log('[7/7] Sending test message to glm-5.2:cloud...');
  console.log('   → "Hi! What are you and what can you do?"');
  console.log('');

  const startMs = Date.now();
  try {
    const result = await loop.run(sessionId, 'Hi! What are you and what can you do?');

    console.log('═'.repeat(50));
    console.log('🔮 RESPONSE:');
    console.log('─'.repeat(50));
    console.log(result.response);
    console.log('─'.repeat(50));
    console.log(`\n⏱  ${result.durationMs}ms | ${result.totalTokens || '?'} tokens | ${result.rounds} round(s)`);
    if (result.toolCalls.length > 0) {
      console.log(`🔧 Tools used: ${result.toolCalls.map(tc => tc.toolName).join(', ')}`);
    }
    console.log('');
    console.log('✅ Live smoke test PASSED — engine booted, LLM responded.');
  } catch (err) {
    console.log('');
    console.log('❌ Live smoke test FAILED:');
    console.error(err);
    process.exit(1);
  }

  // Save session state for inspection
  await engine.memory.saveSessionState({
    currentTask: 'Live smoke test completed',
    progress: 'Agent responded successfully',
    nextSteps: ['Continue to M2: self-improvement'],
    recentFiles: [],
    mood: 'excited',
  });

  console.log('💾 Session state saved.');
  console.log('');
  console.log('🔮 M1 LIVE TEST COMPLETE.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
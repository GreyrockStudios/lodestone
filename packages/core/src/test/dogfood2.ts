/**
 * Dogfood test 2 — trigger actual tool calls through the full pipeline.
 * Verifies: LLM → tool call → Lodestone execution → result back to LLM.
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
import { existsSync, mkdirSync, writeFileSync } from 'fs';

async function main() {
  console.log('=== Lodestone Dogfood Test 2: Tool Execution ===\n');

  const root = resolve(import.meta.dirname, '../../../../');
  const dataDir = resolve(root, 'data');
  const wikiDir = resolve(root, 'memory/wiki');
  const identityDir = resolve(root, 'workspace');
  const memoryDir = resolve(root, 'data/lancedb');
  for (const d of [dataDir, wikiDir, identityDir, memoryDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // Create a test wiki page so wiki-resolve can find it
  const testWikiPage = resolve(wikiDir, 'test-page.md');
  if (!existsSync(testWikiPage)) {
    writeFileSync(testWikiPage, `---
title: Test Page
created: 2026-06-18
updated: 2026-06-18
status: active
tags: [test]
---
# Test Page
This is a test wiki page for dogfood testing.
It links to [[nonexistent]] for testing resolution.
`);
  }

  // Also create a decisions directory
  const decisionsDir = resolve(dataDir, 'decisions.json');
  if (!existsSync(decisionsDir)) {
    writeFileSync(decisionsDir, '[]');
  }

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
        maxTokens: 4096,
      },
    },
  };

  console.log('1. Creating engine...');
  const engine = new LodestoneEngine(config);
  await engine.memory.init();

  console.log('2. Registering tools...');
  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(decisionsDir));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  console.log('3. Starting engine...');
  await engine.start();

  console.log('4. Creating session + agent loop...');
  const sessionId = engine.createSession();
  const loop = new AgentLoop(engine);
  const stream = new StreamHandler();

  // Track events
  let toolCallCount = 0;
  let toolResultCount = 0;
  let streamedText = '';

  stream.on('text_delta', (event: StreamEvent) => {
    const data = event.data as { text?: string };
    if (data.text) {
      process.stdout.write(data.text);
      streamedText += data.text;
    }
  });
  stream.on('tool_call_start', (event: StreamEvent) => {
    const data = event.data as { toolName?: string };
    toolCallCount++;
    console.log(`\n  [TOOL CALL: ${data.toolName || 'unknown'}]`);
  });
  stream.on('tool_result', (event: StreamEvent) => {
    const data = event.data as { toolName?: string; success?: boolean };
    toolResultCount++;
    console.log(`  [TOOL RESULT: ${data.toolName || 'unknown'} — ${data.success ? 'success' : 'fail'}]`);
  });

  // Messages designed to trigger tool calls
  const testCases = [
    {
      msg: 'Use the wiki-resolve tool to resolve the wikilink [[test-page]]. What does it return?',
      expectTool: true,
      expectTextContains: 'test',
    },
    {
      msg: 'Use the business-hours tool to check if it is currently business hours.',
      expectTool: true,
      expectTextContains: 'business',
    },
    {
      msg: 'Use the decision-log tool to add a decision: "Use Lodestone for internal agent framework" with rationale "Best architecture for our needs".',
      expectTool: true,
      expectTextContains: 'decision',
    },
  ];

  let passCount = 0;
  let failCount = 0;

  for (const tc of testCases) {
    console.log(`\n\n--- User: "${tc.msg}" ---`);
    console.log('Assistant: ');

    try {
      const result = await loop.run(sessionId, tc.msg, stream);
      console.log('\n');
      console.log(`  → Response length: ${result.response.length} chars`);
      console.log(`  → Tool calls: ${result.toolCalls?.length || 0}`);
      console.log(`  → Stream events: ${toolCallCount} tool calls, ${toolResultCount} tool results`);
      console.log(`  → Tokens: ${result.totalTokens || 'n/a'}`);
      console.log(`  → Rounds: ${result.rounds}`);

      let ok = true;
      const errors: string[] = [];

      if (result.response.length === 0) {
        errors.push('empty response');
        ok = false;
      }

      if (tc.expectTool && (result.toolCalls?.length || 0) === 0) {
        errors.push('expected tool call but none made');
        ok = false;
      }

      if (tc.expectTextContains && !result.response.toLowerCase().includes(tc.expectTextContains.toLowerCase())) {
        errors.push(`expected "${tc.expectTextContains}" in response`);
        ok = false;
      }

      // Check token tracking (Ollama cloud models return 0 — not a Lodestone bug)
      if (!result.totalTokens) {
        console.log('  ℹ️ Token count: n/a (Ollama cloud models return 0 usage)');
      }

      if (ok) {
        console.log('  ✅ PASS');
        passCount++;
      } else {
        // Token count missing is a warning, not a fail
        const hardErrors = errors.filter(e => !e.includes('token count'));
        if (hardErrors.length === 0) {
          console.log(`  ⚠️ PASS (with warning: ${errors.join(', ')})`);
          passCount++;
        } else {
          console.log(`  ❌ FAIL — ${errors.join(', ')}`);
          failCount++;
        }
      }
    } catch (err) {
      console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }

    // Reset counters between tests
    toolCallCount = 0;
    toolResultCount = 0;
    streamedText = '';
  }

  // Test: Verify tool results are in session history
  console.log('\n--- Test: Tool results in session history ---');
  try {
    const session = engine.sessions.get(sessionId);
    const msgs = session?.messages || [];
    console.log(`  Total messages in session: ${msgs.length}`);
    const toolMsgs = msgs.filter(m => m.content.includes('[Tool:'));
    console.log(`  Tool result messages: ${toolMsgs.length}`);
    if (toolMsgs.length > 0) {
      console.log('  ✅ PASS — tool results tracked in session');
      passCount++;
    } else {
      console.log('  ⚠️ WARN — no tool result messages found (LLM may not have called tools)');
      failCount++;
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  await engine.stop();
  console.log(`\n📊 Dogfood 2 Results: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
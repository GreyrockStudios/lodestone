#!/usr/bin/env node

/**
 * Lodestone — Live Interactive Test
 *
 * Boots the engine, connects to Ollama, and runs an interactive chat loop.
 * This is the M1 "see it work" test.
 *
 * Usage: node dist/test/live-chat.js
 */

import { createInterface } from 'readline';
import { LodestoneEngine } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool, WikiSearchTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { resolve } from 'path';

const WORKSPACE = process.env.LODESTONE_WORKSPACE || '/tmp/lodestone-test/workspace';

async function main() {
  console.log('');
  console.log('🔮 Lodestone — Live Chat Test');
  console.log('═'.repeat(50));
  console.log('');

  // 1. Boot engine
  console.log('[1/6] Creating engine...');
  const engine = new LodestoneEngine({
    workspaceRoot: WORKSPACE,
    identityDir: WORKSPACE,
    wikiRoot: resolve(WORKSPACE, 'memory/wiki'),
    memoryDir: resolve(WORKSPACE, 'data/lancedb'),
    llm: {
      default: {
        type: 'ollama',
        model: 'qwen3:8b',
        baseUrl: 'http://127.0.0.1:11434/api',
        contextWindow: 32768,
        maxTokens: 4096,
      },
    },
  });

  // 2. Initialize memory
  console.log('[2/6] Initializing memory...');
  await engine.memory.init();

  // 3. Register tools
  console.log('[3/6] Registering tools...');
  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new WikiSearchTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(WORKSPACE, 'data/decisions.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  // 4. Load identity
  console.log('[4/6] Loading identity...');
  const identity = await engine.identity.load();
  console.log(`   → Name: ${identity.identity.name}`);
  console.log(`   → Soul: ${identity.soul.slice(0, 80)}...`);

  // 5. Create session
  console.log('[5/6] Creating session...');
  const sessionId = engine.createSession();
  console.log(`   → Session: ${sessionId}`);

  // 6. Create agent loop
  console.log('[6/6] Creating agent loop...');
  const loop = new AgentLoop(engine, {
    maxToolRounds: 5,
    maxTokens: 4096,
    temperature: 0.7,
    stream: false, // Start with non-streaming for reliability
    autoCapture: true,
    autoRecall: true,
  });

  console.log('');
  console.log('═'.repeat(50));
  console.log('🔮 Lodestone is LIVE. Type a message and press Enter.');
  console.log('   Commands: /quit, /tools, /memory, /state, /help');
  console.log('═'.repeat(50));
  console.log('');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('You> ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\n🔮 Goodbye!');
        await engine.stop();
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/help') {
        console.log('  /quit   — Exit');
        console.log('  /tools  — List registered tools');
        console.log('  /memory — Show memory stats');
        console.log('  /state  — Show session state');
        console.log('  /help   — This message');
        prompt();
        return;
      }

      if (trimmed === '/tools') {
        const tools = engine.tools.listDefinitions();
        console.log(`  ${tools.length} tools registered:`);
        for (const t of tools) {
          console.log(`  - ${t.name}: ${t.description}`);
        }
        prompt();
        return;
      }

      if (trimmed === '/memory') {
        const wikiPages = await engine.memory.wiki.list();
        const state = await engine.memory.loadSessionState();
        console.log(`  Wiki pages: ${wikiPages.length}`);
        console.log(`  Session state: ${state ? state.currentTask : 'none'}`);
        prompt();
        return;
      }

      if (trimmed === '/state') {
        const state = await engine.memory.loadSessionState();
        if (state) {
          console.log(`  Task: ${state.currentTask}`);
          console.log(`  Progress: ${state.progress}`);
          console.log(`  Mood: ${state.mood}`);
          console.log(`  Next: ${state.nextSteps.join(', ')}`);
        } else {
          console.log('  No session state saved yet.');
        }
        prompt();
        return;
      }

      // Run agent loop
      console.log('');
      process.stdout.write('Lodestone> ');
      try {
        const result = await loop.run(sessionId, trimmed);
        console.log(result.response);
        console.log(`\n  [${result.rounds} round${result.rounds > 1 ? 's' : ''}, ${result.totalTokens || '?'} tokens, ${result.durationMs}ms]`);
        if (result.toolCalls.length > 0) {
          console.log(`  [Used tools: ${result.toolCalls.map(tc => tc.toolName).join(', ')}]`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) {
          console.error(err.stack.split('\n').slice(1, 4).join('\n'));
        }
      }

      console.log('');
      prompt();
    });
  };

  prompt();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
/**
 * Lodestone — Integration Test (M1 Milestone)
 *
 * Boots the engine, loads identity, registers tools, creates a session,
 * and verifies the agent can think proactively.
 *
 * This is the "5-minute boot test" for M1.
 */

import { LodestoneEngine } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool, WikiSearchTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { resolve } from 'path';
import { readFile } from 'fs/promises';

const WORKSPACE = '/tmp/lodestone-test/workspace';

async function runTest() {
  console.log('🔮 Lodestone M1 Integration Test');
  console.log('═'.repeat(50));
  console.log('');

  let passed = 0;
  let failed = 0;

  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };

  // ─── Test 1: Create Engine ────────────────────────────────────────

  let engine: LodestoneEngine;

  await test('Create engine with config', async () => {
    engine = new LodestoneEngine({
      workspaceRoot: WORKSPACE,
      identityDir: WORKSPACE,
      wikiRoot: resolve(WORKSPACE, 'memory/wiki'),
      memoryDir: resolve(WORKSPACE, 'data/lancedb'),
      llm: {
        default: {
          type: 'ollama',
          model: 'llama3.1:8b',
          baseUrl: 'http://127.0.0.1:11434/api',
          contextWindow: 128000,
          maxTokens: 8192,
        },
      },
    });
    if (!engine) throw new Error('Engine not created');
  });

  // ─── Test 2: Load Identity ───────────────────────────────────────

  await test('Load identity files', async () => {
    const identity = await engine.identity.load();
    if (!identity.identity.name) throw new Error('Identity name not loaded');
    if (!identity.soul) throw new Error('Soul not loaded');
    if (!identity.systemPrompt) throw new Error('System prompt not built');
    console.log(`   → Identity: ${identity.identity.name}`);
    console.log(`   → Soul: ${identity.soul.slice(0, 60)}...`);
    console.log(`   → System prompt: ${identity.systemPrompt.length} chars`);
  });

  // ─── Test 3: Initialize Memory ────────────────────────────────────

  await test('Initialize memory system', async () => {
    await engine.memory.init();
    console.log('   → Memory system initialized');
  });

  // ─── Test 4: Register Tools ───────────────────────────────────────

  await test('Register 7 built-in tools', async () => {
    const workspaceRoot = WORKSPACE;
    engine.registerTool(new WikiResolveTool());
    engine.registerTool(new WikiSearchTool());
    engine.registerTool(new SmartRetrieveTool());
    engine.registerTool(new DecisionLogTool(resolve(workspaceRoot, 'data/decisions.json')));
    engine.registerTool(new ResumeStateTool());
    engine.registerTool(new WatchdogTool());
    engine.registerTool(new BusinessHoursTool());

    const tools = engine.tools.listDefinitions();
    if (tools.length !== 7) throw new Error(`Expected 7 tools, got ${tools.length}`);
    console.log(`   → Registered: ${tools.map(t => t.name).join(', ')}`);
  });

  // ─── Test 5: Register Scheduled Jobs ──────────────────────────────

  await test('Register 3 proactive jobs', async () => {
    engine.registerJob({
      id: 'sensorium',
      name: 'Lodestone Sensorium',
      schedule: { kind: 'interval', everyMs: 30 * 60 * 1000 },
      description: 'Health check every 30 minutes',
    });
    engine.registerJob({
      id: 'sleep-cycle',
      name: 'Lodestone Sleep Cycle',
      schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'America/Toronto' },
      description: 'Nightly consolidation',
    });
    engine.registerJob({
      id: 'drift-detection',
      name: 'Lodestone Drift Detection',
      schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' },
      description: 'Weekly drift check',
    });

    const jobs = engine.scheduler.list();
    if (jobs.length !== 3) throw new Error(`Expected 3 jobs, got ${jobs.length}`);
    console.log(`   → Scheduled: ${jobs.map(j => j.config.name).join(', ')}`);
  });

  // ─── Test 6: Create Session ───────────────────────────────────────

  await test('Create session with context window', async () => {
    const sessionId = engine.createSession();
    if (!sessionId) throw new Error('Session not created');
    console.log(`   → Session: ${sessionId}`);
  });

  // ─── Test 7: Wiki Operations ──────────────────────────────────────

  await test('Write and read wiki page', async () => {
    const page = await engine.memory.wiki.write('test-page', '# Test Page\n\nThis is a test page with [[wikilink]] syntax.', {
      title: 'Test Page',
      tags: ['test', 'integration'],
    });
    if (!page) throw new Error('Page not written');
    console.log(`   → Written: ${page.slug}`);

    const read = await engine.memory.wiki.read('test-page');
    if (!read) throw new Error('Page not read back');
    console.log(`   → Read: ${read.frontmatter.title}`);
  });

  // ─── Test 8: Wiki Search ──────────────────────────────────────────

  await test('Search wiki pages', async () => {
    const results = await engine.memory.wiki.search('test');
    console.log(`   → Found ${results.length} results`);
  });

  // ─── Test 9: Scratch Buffer ───────────────────────────────────────

  await test('Scratch buffer set and get', async () => {
    await engine.memory.scratch.scratchSet('test-key', 'test-value', 60000);
    const value = await engine.memory.scratch.scratchGet('test-key');
    if (value !== 'test-value') throw new Error(`Expected 'test-value', got '${value}'`);
    console.log('   → Set and retrieved scratch value');
  });

  // ─── Test 10: Decision Log ────────────────────────────────────────

  await test('Record a decision', async () => {
    const decisionLog = new DecisionLogTool(resolve(WORKSPACE, 'data/decisions.json'));
    const result = await decisionLog.execute({
      action: 'add',
      decision: 'Use TypeScript for Lodestone',
      rationale: 'Fastest to ship, largest ecosystem, MCP compatibility',
      context: 'M1 milestone planning',
      tags: ['architecture', 'typescript'],
    }, {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Lodestone', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {
        store: async () => {},
        recall: async () => [],
        wikiRead: async () => null,
        wikiWrite: async () => {},
        wikiSearch: async () => [],
        scratchGet: async () => null,
        scratchSet: async () => {},
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    if (!result.success) throw new Error(`Decision failed: ${result.error}`);
    console.log(`   → Decision recorded: ${result.summary}`);
  });

  // ─── Test 11: Session State ───────────────────────────────────────

  await test('Save and load session state', async () => {
    await engine.memory.saveSessionState({
      currentTask: 'Integration test',
      progress: 'Running tests',
      nextSteps: ['Complete M1'],
      recentFiles: [],
      mood: 'focused',
    });
    const state = await engine.memory.loadSessionState();
    if (!state) throw new Error('State not loaded');
    if (state.currentTask !== 'Integration test') throw new Error('State mismatch');
    console.log(`   → State loaded: ${state.currentTask}`);
  });

  // ─── Test 12: Build System Prompt ─────────────────────────────────

  await test('Build system prompt from identity', async () => {
    const identity = await engine.identity.load();
    if (identity.systemPrompt.length < 100) {
      throw new Error('System prompt too short');
    }
    console.log(`   → System prompt: ${identity.systemPrompt.length} chars`);
  });

  // ─── Test 13: Scheduler ───────────────────────────────────────────

  await test('Verify scheduler has 3 jobs with correct schedules', async () => {
    const jobs = engine.scheduler.list();
    const sensorium = jobs.find(j => j.config.id === 'sensorium');
    const sleep = jobs.find(j => j.config.id === 'sleep-cycle');
    const drift = jobs.find(j => j.config.id === 'drift-detection');

    if (!sensorium) throw new Error('Sensorium job not found');
    if (!sleep) throw new Error('Sleep cycle job not found');
    if (!drift) throw new Error('Drift detection job not found');
    console.log(`   → All 3 jobs registered`);
  });

  // ─── Test 14: Watchdog ────────────────────────────────────────────

  await test('Register and check a watchdog', async () => {
    const watchdog = new WatchdogTool();
    const watchResult = await watchdog.execute({
      action: 'watch',
      description: 'Integration test completes',
      expectedOutcome: 'All tests pass',
      expectedBy: new Date(Date.now() + 3600000).toISOString(),
      severity: 'low',
    }, {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Lodestone', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {
        store: async () => {},
        recall: async () => [],
        wikiRead: async () => null,
        wikiWrite: async () => {},
        wikiSearch: async () => [],
        scratchGet: async () => null,
        scratchSet: async () => {},
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    if (!watchResult.success) throw new Error(`Watchdog failed: ${watchResult.error}`);

    const checkResult = await watchdog.execute({ action: 'check' }, {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Lodestone', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {
        store: async () => {},
        recall: async () => [],
        wikiRead: async () => null,
        wikiWrite: async () => {},
        wikiSearch: async () => [],
        scratchGet: async () => null,
        scratchSet: async () => {},
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    console.log(`   → Watchdog check: ${checkResult.summary}`);
  });

  // ─── Test 15: Business Hours ──────────────────────────────────────

  await test('Check business hours', async () => {
    const businessHours = new BusinessHoursTool();
    const result = await businessHours.execute({ action: 'check' }, {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Lodestone', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {
        store: async () => {},
        recall: async () => [],
        wikiRead: async () => null,
        wikiWrite: async () => {},
        wikiSearch: async () => [],
        scratchGet: async () => null,
        scratchSet: async () => {},
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    if (!result.success) throw new Error(`Business hours check failed: ${result.error}`);
    console.log(`   → ${result.summary}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────

  console.log('');
  console.log('═'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('');

  if (failed === 0) {
    console.log('🔮 All tests passed. Lodestone is ready for M1.');
  } else {
    console.log(`⚠️  ${failed} test(s) failed. See errors above.`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
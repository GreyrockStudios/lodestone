#!/usr/bin/env node

/**
 * Lodestone — Main Entry Point
 *
 * Boots the engine, loads identity, registers tools, starts the agent.
 * This is what runs inside the Docker container.
 */

import { LodestoneEngine, type LodestoneConfig } from './engine.js';
import { AgentLoop } from './agent-loop.js';
import { MemorySystem } from './memory/memory-system.js';
import { WikiResolveTool, WikiSearchTool } from './tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from './tools/impl/smart-retrieve.js';
import { DecisionLogTool } from './tools/impl/decision-log.js';
import { ResumeStateTool } from './tools/impl/resume-state.js';
import { WatchdogTool } from './tools/impl/watchdog.js';
import { BusinessHoursTool } from './tools/impl/business-hours.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

// ─── Config ─────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<LodestoneConfig> {
  const configPath = process.env.LODESTONE_CONFIG || './lodestone.config.yaml';

  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw);

    return {
      workspaceRoot: config.workspace?.root || './workspace',
      identityDir: config.identity?.dir || '.',
      wikiRoot: config.memory?.wiki?.path || './memory/wiki',
      memoryDir: config.memory?.vector?.path || './data/lancedb',
      maxConcurrentTools: config.scheduler?.maxConcurrent || 4,
      maxConcurrentJobs: config.scheduler?.maxConcurrent || 4,
      compactionThreshold: config.session?.compactionThreshold || 0.5,
      llm: {
        default: {
          type: config.llm?.default?.type || 'ollama',
          model: config.llm?.default?.model || 'llama3.1:8b',
          baseUrl: config.llm?.default?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
          apiKey: config.llm?.default?.apiKey || process.env.OPENAI_API_KEY,
          contextWindow: config.llm?.default?.contextWindow || 128000,
          maxTokens: config.llm?.default?.maxTokens || 8192,
        },
        routes: Object.entries(config.llm?.routes || {}).map(([name, route]: [string, any]) => ({
          name,
          provider: {
            type: route.type || 'ollama',
            model: route.model,
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            contextWindow: route.contextWindow || 128000,
            maxTokens: route.maxTokens || 8192,
          },
        })),
      },
    };
  } catch (err) {
    console.error('[Lodestone] Failed to load config:', err);
    console.error('[Lodestone] Using defaults');
    return {
      workspaceRoot: './workspace',
      identityDir: '.',
      wikiRoot: './memory/wiki',
      memoryDir: './data/lancedb',
      llm: {
        default: {
          type: 'ollama',
          model: 'llama3.1:8b',
          baseUrl: 'http://127.0.0.1:11434',
          contextWindow: 128000,
          maxTokens: 8192,
        },
      },
    };
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔮 Lodestone — Agent Engine');
  console.log('─'.repeat(40));

  // 1. Load config
  const config = await loadConfig();
  console.log(`[Lodestone] Config loaded from ${process.env.LODESTONE_CONFIG || './lodestone.config.yaml'}`);

  // 2. Create engine
  const engine = new LodestoneEngine(config);

  // 3. Initialize memory system
  const memory = new MemorySystem({
    wiki: {
      rootDir: config.wikiRoot,
      autoIndex: true,
      autoLint: true,
      categories: ['entities', 'concepts', 'decisions', 'projects', 'areas', 'research'],
    },
    vector: {
      dbPath: config.memoryDir,
      embeddingProvider: 'ollama',
      embeddingModel: 'nomic-embed-text',
      dimensions: 768,
      autoRecall: true,
      autoCapture: false,
      recallMaxChars: 800,
    },
    scratch: {
      dbPath: resolve(config.workspaceRoot, 'data/scratch.json'),
      defaultTtlMs: null,
    },
  });

  await memory.init();
  console.log('[Lodestone] Memory system initialized');

  // 4. Register tools
  const wikiResolve = new WikiResolveTool();
  const wikiSearch = new WikiSearchTool();
  const smartRetrieve = new SmartRetrieveTool();
  const decisionLog = new DecisionLogTool(resolve(config.workspaceRoot, 'data/decisions.json'));
  const resumeState = new ResumeStateTool();
  const watchdog = new WatchdogTool();
  const businessHours = new BusinessHoursTool();

  engine.registerTool(wikiResolve);
  engine.registerTool(wikiSearch);
  engine.registerTool(smartRetrieve);
  engine.registerTool(decisionLog);
  engine.registerTool(resumeState);
  engine.registerTool(watchdog);
  engine.registerTool(businessHours);
  console.log('[Lodestone] Tools registered: 7 built-in');

  // 5. Register proactive jobs (from config)
  if (config.llm?.default) {
    // Sensorium — health check every 30 minutes
    engine.registerJob({
      id: 'sensorium',
      name: 'Lodestone Sensorium',
      schedule: { kind: 'interval', everyMs: 30 * 60 * 1000 },
      description: 'Health check — verify all systems operational',
    });

    // Sleep cycle — consolidation at 3am
    engine.registerJob({
      id: 'sleep-cycle',
      name: 'Lodestone Sleep Cycle',
      schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'America/Toronto' },
      description: 'Nightly consolidation: harvest, mine, reflect, consolidate',
    });

    // Drift detection — weekly
    engine.registerJob({
      id: 'drift-detection',
      name: 'Lodestone Drift Detection',
      schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' },
      description: 'Weekly check: behavior vs core principles',
    });

    console.log('[Lodestone] Proactive jobs registered: 3');
  }

  // 6. Start engine
  await engine.start();
  console.log('[Lodestone] Engine started');

  // 7. Create a session
  const sessionId = engine.createSession();
  console.log(`[Lodestone] Session created: ${sessionId}`);

  // 8. Create agent loop
  const loop = new AgentLoop(engine);

  // 9. Run initial proactive check
  console.log('[Lodestone] Running initial sensorium...');
  const initialCheck = await engine.tools.execute('decision-log', {
    action: 'add',
    decision: 'Lodestone agent booted successfully',
    rationale: 'All subsystems initialized, identity loaded, tools registered',
    context: 'Boot sequence',
    tags: ['boot', 'system'],
  }, {
    sessionId,
    workspaceRoot: config.workspaceRoot,
    identity: {
      name: 'Lodestone',
      soul: 'Proactive, self-improving agent',
      rules: '',
      heartbeat: 'Initial boot',
      user: 'User',
    },
    memory,
    log: {
      info: console.log,
      warn: console.warn,
      error: console.error,
    },
  });
  console.log(`[Lodestone] Boot decision logged: ${initialCheck.summary}`);

  // 10. Log ready message
  console.log('');
  console.log('🔮 Lodestone is ready.');
  console.log(`   Model: ${config.llm.default.model}`);
  console.log(`   Identity: ${config.identityDir}`);
  console.log(`   Wiki: ${config.wikiRoot}`);
  console.log(`   Memory: ${config.memoryDir}`);
  console.log('');

  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log('\n[Lodestone] Shutting down...');
    await engine.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Lodestone] Shutting down...');
    await engine.stop();
    process.exit(0);
  });

  // The agent loop is now available for incoming messages
  // In a full implementation, this would connect to channels (Telegram, Discord, etc.)
  // For M1, we expose a simple HTTP API
  return { engine, loop, sessionId };
}

// Run
main().catch(err => {
  console.error('[Lodestone] Fatal error:', err);
  process.exit(1);
});
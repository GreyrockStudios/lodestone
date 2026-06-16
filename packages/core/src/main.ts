#!/usr/bin/env node

/**
 * Lodestone — Main Entry Point
 *
 * Boots the engine, loads identity, registers tools, starts the agent.
 * This is what runs inside the Docker container.
 */

import { LodestoneEngine, type LodestoneConfig } from './engine.js';
import { AgentLoop } from './agent-loop.js';
import { WikiResolveTool, WikiSearchTool } from './tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from './tools/impl/smart-retrieve.js';
import { DecisionLogTool } from './tools/impl/decision-log.js';
import { ResumeStateTool } from './tools/impl/resume-state.js';
import { WatchdogTool } from './tools/impl/watchdog.js';
import { BusinessHoursTool } from './tools/impl/business-hours.js';
import { createWorkspaceFromAnswers, PROVIDER_INFO } from './tui-onboarding/workspace-creator.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { createInterface } from 'readline';

// ─── Config ─────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<LodestoneConfig> {
  const configPath = process.env.LODESTONE_CONFIG || './lodestone.config.yaml';

  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw);

    return {
      workspaceRoot: config.workspace?.root || process.env.LODESTONE_WORKSPACE || './workspace',
      identityDir: config.identity?.dir || '.',
      wikiRoot: config.memory?.wiki?.path || './memory/wiki',
      memoryDir: config.memory?.vector?.path || './data/lancedb',
      maxConcurrentTools: config.scheduler?.maxConcurrent || 4,
      maxConcurrentJobs: config.scheduler?.maxConcurrent || 4,
      compactionThreshold: config.session?.compactionThreshold || 0.5,
      llm: {
        default: {
          type: config.llm?.default?.type || 'ollama',
          model: config.llm?.default?.model || 'glm-5.1:cloud',
          baseUrl: config.llm?.default?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api',
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
      channels: config.channels ? {
        channels: Object.entries(config.channels || {}).map(([name, ch]: [string, any]) => ({
          ...ch,
          // name is used as key in config but channels array doesn't need it
        })).filter((ch: any) => ch.enabled !== false),
      } : undefined,
    };
  } catch (err) {
    console.error('[Lodestone] Failed to load config:', err);
    console.error('[Lodestone] Using defaults');
    return {
      workspaceRoot: process.env.LODESTONE_WORKSPACE || './workspace',
      identityDir: '.',
      wikiRoot: './memory/wiki',
      memoryDir: './data/lancedb',
      llm: {
        default: {
          type: 'ollama',
          model: 'glm-5.1:cloud',
          baseUrl: 'http://127.0.0.1:11434/api',
          contextWindow: 128000,
          maxTokens: 8192,
        },
      },
    };
  }
}

// ─── Headless Onboarding ──────────────────────────────────────────────────

const HEADLESS_TEMPLATES = ['general', 'developer', 'business', 'creative', 'researcher'] as const;
const HEADLESS_PROVIDERS = ['ollama', 'openai', 'anthropic'] as const;

async function runHeadlessOnboarding(workspaceRoot: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log('\n🔮 Welcome to Lodestone!\n');
  console.log('No workspace found. Let\'s set up your agent.\n');
  console.log('You can change everything later in your config files.\n');

  const agentName = (await ask('What should your agent be called? [Lodestone]: ')).trim() || 'Lodestone';
  const userName = (await ask('What\'s your name? [User]: ')).trim() || 'User';

  // Template
  console.log('\nWhat kind of work will you do?');
  for (let i = 0; i < HEADLESS_TEMPLATES.length; i++) {
    const t = PROVIDER_INFO[HEADLESS_TEMPLATES[i] as keyof typeof PROVIDER_INFO] || HEADLESS_TEMPLATES[i];
    console.log(`  ${i + 1}. ${HEADLESS_TEMPLATES[i]}`);
  }
  const tIdx = Math.max(0, Math.min(HEADLESS_TEMPLATES.length - 1, parseInt(await ask(`Choose [1-${HEADLESS_TEMPLATES.length}]: `)) - 1 || 0));
  const template = HEADLESS_TEMPLATES[tIdx];

  // Provider
  console.log('\nWhich LLM provider?');
  for (let i = 0; i < HEADLESS_PROVIDERS.length; i++) {
    const p = PROVIDER_INFO[HEADLESS_PROVIDERS[i]];
    console.log(`  ${i + 1}. ${p.emoji} ${p.name} — ${p.desc}`);
  }
  const pIdx = Math.max(0, Math.min(HEADLESS_PROVIDERS.length - 1, parseInt(await ask(`Choose [1-${HEADLESS_PROVIDERS.length}]: `)) - 1 || 0));
  const provider = HEADLESS_PROVIDERS[pIdx];

  // Model
  const models = PROVIDER_INFO[provider].models;
  console.log(`\nWhich model?`);
  for (let i = 0; i < models.length; i++) {
    console.log(`  ${i + 1}. ${models[i]}${i === 0 ? ' (recommended)' : ''}`);
  }
  const mIdx = Math.max(0, Math.min(models.length - 1, parseInt(await ask(`Choose [1-${models.length}]: `)) - 1 || 0));
  const model = models[mIdx];

  rl.close();

  // Create workspace
  const identityDir = resolve(workspaceRoot, 'workspace');
  createWorkspaceFromAnswers({
    agentName,
    userName,
    template,
    personality: 'balanced',
    provider,
    model,
    workspacePath: identityDir,
  });

  console.log(`\n✅ Workspace created at ${identityDir}`);
  console.log(`   Identity files written. Config saved to lodestone.config.yaml`);
  console.log(`   Run Lodestone again to start.\n`);
  process.exit(0);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔮 Lodestone — Agent Engine');
  console.log('─'.repeat(40));

  // 0. Check if onboarding is needed
  const workspaceRoot = process.env.LODESTONE_WORKSPACE || './workspace';
  const identityDir = resolve(workspaceRoot, 'workspace');
  if (!existsSync(resolve(identityDir, 'IDENTITY.md'))) {
    await runHeadlessOnboarding(workspaceRoot);
    // runHeadlessOnboarding calls process.exit(0) after creating workspace
    // If we reach here, something went wrong — fall through to normal boot
  }

  // 1. Load config
  const config = await loadConfig();
  console.log(`[Lodestone] Config loaded from ${process.env.LODESTONE_CONFIG || './lodestone.config.yaml'}`);

  // 2. Create engine (this also initializes memory)
  const engine = new LodestoneEngine(config);

  // 3. Initialize memory system
  await engine.memory.init();
  console.log('[Lodestone] Memory system initialized');

  // 4. Register tools
  const decisionLog = new DecisionLogTool(resolve(workspaceRoot, 'data/decisions.json'));

  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new WikiSearchTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(decisionLog);
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());
  console.log('[Lodestone] Tools registered: 7 built-in');

  // 5. Register proactive jobs
  engine.registerJob({
    id: 'sensorium',
    name: 'Lodestone Sensorium',
    schedule: { kind: 'interval', everyMs: 30 * 60 * 1000 },
    description: 'Health check — verify all systems operational',
  });

  engine.registerJob({
    id: 'sleep-cycle',
    name: 'Lodestone Sleep Cycle',
    schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'America/Toronto' },
    description: 'Nightly consolidation: harvest, mine, reflect, consolidate',
  });

  engine.registerJob({
    id: 'drift-detection',
    name: 'Lodestone Drift Detection',
    schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' },
    description: 'Weekly check: behavior vs core principles',
  });

  console.log('[Lodestone] Proactive jobs registered: 3');

  // 6. Start engine
  await engine.start();
  console.log('[Lodestone] Engine started');

  // 7. Create a session
  const sessionId = engine.createSession();
  console.log(`[Lodestone] Session created: ${sessionId}`);

  // 8. Create agent loop
  const loop = new AgentLoop(engine);

  // 9. Log boot decision
  const identity = await engine.identity.load();
  console.log(`[Lodestone] Identity loaded: ${identity.identity.name}`);
  console.log(`[Lodestone] User: ${identity.user.name}`);

  // 10. Wire channels to agent loop
  if (engine.channelManager) {
    engine.channelManager.onMessage(async (message) => {
      try {
        // Find or create a session for this channel+user
        let sessionId: string;
        const existingSession = engine.sessions.list().find(s =>
          s.metadata.channelSessionId === message.sessionId
        );
        if (existingSession) {
          sessionId = existingSession.id;
        } else {
          sessionId = engine.createSession();
          engine.sessions.updateState(sessionId, {
            currentTask: `Chat via ${message.channelId}`,
            progress: 'active',
          });
          // Track which channel session this belongs to
          const session = engine.sessions.get(sessionId);
          if (session) {
            session.metadata.channelSessionId = message.sessionId;
            session.metadata.channelId = message.channelId;
          }
        }

        // Run the agent loop
        const result = await loop.run(sessionId, message.content);
        return result.response;
      } catch (err) {
        console.error('[Lodestone] Channel message error:', err);
        return 'Sorry, an error occurred processing your message.';
      }
    });
    console.log(`[Lodestone] Channels wired: ${engine.channelManager.listChannels().length} active`);
  }

  // 11. Ready
  console.log('');
  console.log('🔮 Lodestone is ready.');
  console.log(`   Model: ${config.llm.default.model}`);
  console.log(`   Provider: ${config.llm.default.type}`);
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

  return { engine, loop, sessionId };
}

// Run
main().catch(err => {
  console.error('[Lodestone] Fatal error:', err);
  process.exit(1);
});
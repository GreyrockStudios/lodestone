#!/usr/bin/env node

/**
 * Lodestone — Main Entry Point
 *
 * Boots the engine, loads identity, registers tools, starts the agent.
 * This is what runs inside the Docker container.
 */

import { bootEngine } from './boot.js';
import { loadConfigFromFile } from './config-loader.js';
import { createWorkspaceFromAnswers, PROVIDER_INFO } from './tui-onboarding/workspace-creator.js';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';

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
    const t = PROVIDER_INFO[HEADLESS_TEMPLATES[i] as keyof typeof PROVIDER_INFO];
    // PROVIDER_INFO doesn't have template info — show template names directly
    const names: Record<string, string> = { general: '⚡ General — balanced assistant', developer: '💻 Developer — coding partner', business: '📊 Business — strategic advisor', creative: '🎨 Creative — writing and design', researcher: '🔬 Researcher — analysis and synthesis' };
    console.log(`  ${i + 1}. ${names[HEADLESS_TEMPLATES[i]]}`);
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

  // 1. Load config
  const config = await loadConfigFromFile(process.env.LODESTONE_CONFIG || './lodestone.config.yaml');
  console.log(`[Lodestone] Config loaded from ${process.env.LODESTONE_CONFIG || './lodestone.config.yaml'}`);

  // 2. Check if onboarding is needed
  const identityPath = resolve(config.identityDir, 'IDENTITY.md');
  if (!existsSync(identityPath)) {
    await runHeadlessOnboarding(config.workspaceRoot);
    // runHeadlessOnboarding calls process.exit(0) after creating workspace
  }

  // 3. Boot engine (register tools, create session, wire channels, start)
  const { engine, loop, sessionId } = await bootEngine(config);
  console.log('[Lodestone] Memory system initialized');
  console.log('[Lodestone] Tools registered: 39 built-in');
  console.log('[Lodestone] Proactive jobs registered: 3');
  console.log('[Lodestone] Engine started');
  console.log(`[Lodestone] Session created: ${sessionId}`);

  // 4. Load identity
  const identity = await engine.identity.load();
  console.log(`[Lodestone] Identity loaded: ${identity.identity.name}`);
  console.log(`[Lodestone] User: ${identity.user.name}`);

  // 5. Log channel status
  if (engine.channelManager) {
    console.log(`[Lodestone] Channels wired: ${engine.channelManager.listChannels().length} active`);
  }

  // 6. Ready
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

/**
 * Boot Lodestone in headless mode — loads config, runs onboarding if needed,
 * starts the engine, and keeps the process alive.
 * Entry point for Docker containers and direct `node` invocation.
 */
export async function boot(): Promise<void> {
  await main();
}
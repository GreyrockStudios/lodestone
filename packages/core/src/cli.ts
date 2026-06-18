#!/usr/bin/env node

/**
 * Lodestone CLI — Command-line interface
 *
 * Usage: lodestone <command> [options]
 *
 * Commands:
 *   init               Initialize a new workspace (interactive)
 *   start              Start the engine
 *   stop               Stop a running engine instance
 *   status             Show engine status (connects to running instance)
 *   config
 *     validate         Validate config file
 *     check            Dry run — validate config and check paths
 *   doctor             Health check — verify all systems
 *   migrate            Run pending migrations
 *     --status         Show migration status without running
 *   channels
 *     list             List configured channels and their health
 *     test <name>      Send a test message to a channel
 *   tools
 *     list             List all registered tools with descriptions
 *   logs
 *     --tail           Tail the log file
 *     --level <lvl>    Filter by log level (trace|debug|info|warn|error|fatal)
 *     --module <name>  Filter by module name
 *   sessions
 *     list             List active sessions
 *     show <id>        Show session details
 *   version            Show version
 *   help               Show this help
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { ConfigValidator } from './utils/config-validator.js';
import { parse as parseYaml } from 'yaml';
import { createServer, IncomingMessage, ServerResponse, get as httpGet, request as httpRequest } from 'http';
import { get as httpsGet, request as httpsRequest } from 'https';
import { spawn } from 'child_process';
import { configInitCommand, parseConfigInitArgs } from './cli/commands/index.js';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

async function main() {
  switch (command) {
    case 'config':
      await configCommand(subcommand, args.slice(2));
      break;

    case 'init': {
      // 'lodestone init' — runs onboarding wizard
      // Flags: --non-interactive, --resume, --template, --provider, --model, --agent-name, --user-name
      const { OnboardingWizard, parseNonInteractiveArgs } = await import('./onboarding/index.js');
      const initArgs = process.argv.slice(3); // skip 'lodestone' + 'init'
      const isNonInteractive = initArgs.includes('--non-interactive');
      const isResume = initArgs.includes('--resume');
      const workspaceRoot = process.env.LODESTONE_WORKSPACE || './workspace';
      const wizard = new OnboardingWizard();
      if (isNonInteractive) {
        const opts = parseNonInteractiveArgs(initArgs);
        wizard.runNonInteractive(opts, workspaceRoot);
      } else if (isResume) {
        await wizard.resume(workspaceRoot);
      } else {
        await wizard.run(workspaceRoot);
      }
      break;
    }

    case 'doctor':
      await doctorCommand();
      break;

    case 'start':
      await startCommand(args.slice(1));
      break;

    case 'stop':
      await stopCommand(args.slice(1));
      break;

    case 'status':
      await statusCommand(args.slice(1));
      break;

    case 'channels':
      await channelsCommand(subcommand, args.slice(2));
      break;

    case 'tools':
      await toolsCommand(subcommand, args.slice(2));
      break;

    case 'logs':
      await logsCommand(args.slice(1));
      break;

    case 'sessions':
      await sessionsCommand(subcommand, args.slice(2));
      break;

    case 'migrate':
      await migrateCommand(args.slice(1));
      break;

    case 'version':
      console.log('Lodestone v0.1.0');
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;

    default:
      console.log(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
🔮 Lodestone — Agent Engine CLI

Usage: lodestone <command> [options]

Commands:
  init               Initialize a new workspace (interactive onboarding)
  start              Start the engine (writes PID to data/lodestone.pid)
  stop               Stop a running engine (reads PID from data/lodestone.pid)
  status             Show engine status (connects to running instance /health)

  config
    init             Generate lodestone.config.yaml with defaults and docs
    validate         Validate config file
    check            Dry run — validate config and check paths

  doctor             Health check — verify all systems

  migrate            Run pending migrations
    --status         Show migration status without running

  channels
    list             List configured channels and their health
    test <name>      Send a test message to a channel

  tools
    list             List all registered tools with descriptions

  logs
    --tail           Tail the log file
    --level <lvl>    Filter by log level (trace|debug|info|warn|error|fatal)
    --module <name>  Filter by module name

  sessions
    list             List active sessions
    show <id>        Show session details

  version            Show version
  help               Show this help

Options:
  --config <path>    Path to config file (default: ./lodestone.config.yaml)

Init options:
  --non-interactive    Skip prompts, use CLI args / env vars (for Docker/CI)
  --resume             Resume from saved partial onboarding progress
  --template <name>    Template: general|developer|business|creative|researcher
  --provider <name>   LLM provider: ollama|openai|anthropic
  --model <name>       Model name (e.g., glm-5.1:cloud)
  --agent-name <name>  Agent name
  --user-name <name>   User name
  --personality <type>  concise|balanced|detailed

Config init options:
  --provider <name>   LLM provider for generated config
  --model <name>      Model name for generated config
  --port <number>      WebChat port
  --output <path>      Config output path
  --force              Overwrite existing config without asking
`);
}

// ─── Config Helpers ──────────────────────────────────────────────────────────

function getConfigPath(opts: string[]): string {
  const idx = opts.indexOf('--config');
  if (idx >= 0 && opts[idx + 1]) {
    return opts[idx + 1];
  }
  return process.env.LODESTONE_CONFIG || './lodestone.config.yaml';
}

function getWorkspaceRoot(opts: string[]): string {
  const idx = opts.indexOf('--workspace');
  if (idx >= 0 && opts[idx + 1]) {
    return opts[idx + 1];
  }
  return process.env.LODESTONE_WORKSPACE || './workspace';
}

function getPidPath(opts: string[]): string {
  return resolve(getWorkspaceRoot(opts), 'data/lodestone.pid');
}

function getDashboardUrl(opts: string[]): string | null {
  // Try to read from config
  const configPath = getConfigPath(opts);
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = parseYaml(raw);
      if (config.dashboard?.port && config.dashboard?.host) {
        return `http://${config.dashboard.host}:${config.dashboard.port}`;
      }
    } catch {
      // Ignore parse errors
    }
  }
  return null;
}

// ─── Start Command ───────────────────────────────────────────────────────────

async function startCommand(opts: string[]): Promise<void> {
  // Check if already running
  const pidPath = getPidPath(opts);
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (pid && isProcessRunning(pid)) {
      console.error(`❌ Lodestone is already running (PID: ${pid})`);
      console.error(`   Stop it first with: lodestone stop`);
      process.exit(1);
    } else {
      // Stale PID file — clean it up
      console.log('Cleaning up stale PID file...');
    }
  }

  console.log('🔮 Starting Lodestone engine...\n');

  // Import and call boot()
  const { boot } = await import('./main.js');
  await boot();
}

// ─── Stop Command ────────────────────────────────────────────────────────────

async function stopCommand(opts: string[]): Promise<void> {
  const pidPath = getPidPath(opts);

  if (!existsSync(pidPath)) {
    console.error('❌ No PID file found. Is Lodestone running?');
    console.error(`   Expected PID file at: ${pidPath}`);
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);

  if (!pid || isNaN(pid)) {
    console.error(`❌ Invalid PID in file: ${pidPath}`);
    process.exit(1);
  }

  if (!isProcessRunning(pid)) {
    console.log(`⚠️  Process ${pid} is not running. Cleaning up stale PID file.`);
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(pidPath);
    } catch {
      // Best-effort
    }
    process.exit(0);
  }

  console.log(`🛑 Stopping Lodestone (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');

    // Wait for the process to exit (up to 10 seconds)
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      if (!isProcessRunning(pid)) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (isProcessRunning(pid)) {
      console.log('Process did not exit after SIGTERM, sending SIGKILL...');
      process.kill(pid, 'SIGKILL');
    }

    // Clean up PID file
    const { unlinkSync } = await import('fs');
    try {
      unlinkSync(pidPath);
    } catch {
      // Best-effort
    }

    console.log('✅ Lodestone stopped.');
  } catch (err) {
    console.error(`❌ Failed to stop process ${pid}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ─── Status Command ──────────────────────────────────────────────────────────

async function statusCommand(opts: string[]): Promise<void> {
  const pidPath = getPidPath(opts);
  const dashboardUrl = getDashboardUrl(opts);

  // Check if process is running
  let running = false;
  let pid: number | null = null;
  if (existsSync(pidPath)) {
    pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    running = pid ? isProcessRunning(pid) : false;
  }

  console.log('🔮 Lodestone Status\n');
  console.log(`  Process: ${running ? '✅ Running' : '❌ Not running'}`);
  if (pid) {
    console.log(`  PID:     ${pid}`);
  }
  console.log(`  PID file: ${existsSync(pidPath) ? pidPath : '(not found)'}`);

  // Try to reach dashboard /health endpoint
  if (dashboardUrl) {
    const healthUrl = `${dashboardUrl}/health`;
    console.log(`\n  Dashboard: ${dashboardUrl}`);
    console.log(`  Health:   ${healthUrl}`);

    try {
      const health = await fetchHealth(healthUrl);
      console.log(`  Status:   ${health.status || 'unknown'}`);
      if (health.uptime) {
        console.log(`  Uptime:   ${formatUptime(Number(health.uptime))}`);
      }
      if (health.version) {
        console.log(`  Version:  ${health.version}`);
      }
      if (health.model) {
        console.log(`  Model:    ${health.model}`);
      }
      if (health.tools !== undefined) {
        console.log(`  Tools:    ${health.tools}`);
      }
      if (health.channels && Array.isArray(health.channels)) {
        console.log(`  Channels: ${health.channels.length} active`);
      }
    } catch (err) {
      console.log(`  Health:   ❌ ${err instanceof Error ? err.message : 'unreachable'}`);
    }
  } else {
    console.log('\n  Dashboard: (not configured)');
  }
}

// ─── Channels Command ─────────────────────────────────────────────────────────

async function channelsCommand(sub: string, opts: string[]): Promise<void> {
  const configPath = getConfigPath(opts);

  if (!existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const config = parseYaml(raw);
  const channels = config.channels || {};

  switch (sub) {
    case 'list': {
      const channelEntries = Object.entries(channels);
      if (channelEntries.length === 0) {
        console.log('No channels configured.');
        return;
      }

      console.log('📡 Channels\n');
      console.log('  Name           Type       Enabled   Status');
      console.log('  ───────────────────────────────────────────');

      // Try to get live status from dashboard
      const dashboardUrl = getDashboardUrl(opts);
      let liveChannels: Array<{ name: string; connected: boolean }> | null = null;
      if (dashboardUrl) {
        try {
          const health = await fetchHealth(`${dashboardUrl}/health`);
          if (Array.isArray(health.channels)) {
            liveChannels = health.channels;
          }
        } catch {
          // Dashboard not reachable — show config only
        }
      }

      for (const [name, ch] of channelEntries) {
        const chConfig = ch as Record<string, unknown>;
        const enabled = chConfig.enabled !== false ? '✅' : '❌';
        const type = (chConfig.type as string) || 'unknown';
        const status = liveChannels
          ? (liveChannels.find((c: { name: string; connected: boolean }) => c.name === name)?.connected ? '🟢 connected' : '🔴 disconnected')
          : '— (engine offline)';

        console.log(`  ${name.padEnd(14)} ${type.padEnd(10)} ${enabled}        ${status}`);
      }
      break;
    }

    case 'test': {
      const channelName = opts[0];
      if (!channelName) {
        console.error('Usage: lodestone channels test <name>');
        process.exit(1);
      }

      const channelConfig = (channels as Record<string, Record<string, unknown>>)[channelName];
      if (!channelConfig) {
        console.error(`❌ Channel '${channelName}' not found in config`);
        process.exit(1);
      }

      console.log(`📤 Sending test message to channel: ${channelName}`);
      console.log(`   Type: ${channelConfig.type || 'unknown'}`);

      // Try to send via dashboard API
      const dashboardUrl = getDashboardUrl(opts);
      if (dashboardUrl) {
        try {
          const response = await fetchViaHttp(
            `${dashboardUrl}/api/channels/test`,
            'POST',
            { channel: channelName, message: '🧪 Lodestone test message' },
          );
          console.log(`   Response: ${JSON.stringify(response)}`);
        } catch (err) {
          console.error(`   ❌ Failed: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      } else {
        console.error('   ❌ Dashboard not configured — cannot send test message');
        console.error('   Configure a dashboard section in your config file to enable channel testing.');
        process.exit(1);
      }
      break;
    }

    default:
      console.log('Usage: lodestone channels <list|test <name>>');
      break;
  }
}

// ─── Tools Command ────────────────────────────────────────────────────────────

async function toolsCommand(sub: string, opts: string[]): Promise<void> {
  switch (sub) {
    case 'list': {
      // Try to get tools from dashboard API
      const dashboardUrl = getDashboardUrl(opts);
      if (dashboardUrl) {
        try {
          const status = await fetchHealth(`${dashboardUrl}/health`);
          if (status.tools !== undefined) {
            console.log(`🔧 Registered Tools (${status.tools} total)\n`);
            console.log('  (Detailed tool list requires direct engine access)');
            return;
          }
        } catch {
          // Fall through to static listing
        }
      }

      // Static listing from the codebase (known built-in tools)
      const knownTools = [
        { id: 'wiki-resolve', name: 'Wiki Resolve', description: 'Resolve a [[wikilink]] to its file path and content' },
        { id: 'wiki-search', name: 'Wiki Search', description: 'Search wiki pages by title, slug, or tag' },
        { id: 'smart-retrieve', name: 'Smart Retrieve', description: 'Get wiki pages ranked by relevance to a query' },
        { id: 'decision-log-add', name: 'Decision Log Add', description: 'Record a decision with rationale' },
        { id: 'decision-log-get', name: 'Decision Log Get', description: 'Get full details of a specific decision' },
        { id: 'decision-log-list', name: 'Decision Log List', description: 'List recent decisions' },
        { id: 'decision-log-search', name: 'Decision Log Search', description: 'Search decisions by keyword' },
        { id: 'resume-state-save', name: 'Resume State Save', description: 'Save current task state' },
        { id: 'resume-state-load', name: 'Resume State Load', description: 'Load last saved state' },
        { id: 'resume-state-clear', name: 'Resume State Clear', description: 'Clear resume state' },
        { id: 'watchdog-watch', name: 'Watchdog Watch', description: 'Register an expected outcome with deadline' },
        { id: 'watchdog-check', name: 'Watchdog Check', description: 'Check all watches for missed deadlines' },
        { id: 'watchdog-list', name: 'Watchdog List', description: 'List all watches' },
        { id: 'watchdog-resolve', name: 'Watchdog Resolve', description: 'Mark a watch as met or cancelled' },
        { id: 'business-hours-check', name: 'Business Hours Check', description: 'Check if currently business hours' },
        { id: 'business-hours-should-send', name: 'Business Hours Should Send', description: 'Check if a message should be sent now' },
      ];

      console.log('🔧 Registered Tools\n');
      console.log('  ID                          Name                        Description');
      console.log('  ──────────────────────────────────────────────────────────────────────────');
      for (const tool of knownTools) {
        console.log(`  ${tool.id.padEnd(28)} ${tool.name.padEnd(28)} ${tool.description}`);
      }
      console.log(`\n  Total: ${knownTools.length} built-in tools`);
      console.log('  Note: Additional tools may be registered by plugins at runtime.');
      break;
    }

    default:
      console.log('Usage: lodestone tools <list>');
      break;
  }
}

// ─── Logs Command ─────────────────────────────────────────────────────────────

async function logsCommand(opts: string[]): Promise<void> {
  const wantTail = opts.includes('--tail');
  const levelIdx = opts.indexOf('--level');
  const moduleIdx = opts.indexOf('--module');
  const level = levelIdx >= 0 ? opts[levelIdx + 1] : null;
  const moduleName = moduleIdx >= 0 ? opts[moduleIdx + 1] : null;

  // Find log file
  const workspaceRoot = getWorkspaceRoot(opts);
  const logFile = resolve(workspaceRoot, 'data/logs/lodestone.log');

  // Also check config for a custom log file path
  const configPath = getConfigPath(opts);
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = parseYaml(raw);
      if (config.logging?.file) {
        // Config-specified log file takes precedence
      }
    } catch {
      // Ignore
    }
  }

  if (!existsSync(logFile)) {
    console.error(`❌ Log file not found: ${logFile}`);
    console.error('   Make sure file logging is configured in your lodestone.config.yaml');
    console.error('   Example config:');
    console.error('     logging:');
    console.error('       file: ./workspace/data/logs/lodestone.log');
    console.error('       minLevel: info');
    process.exit(1);
  }

  if (wantTail) {
    console.log(`📊 Tailing ${logFile} (Ctrl+C to stop)\n`);
    // Use tail -f via spawn
    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
    tail.on('exit', () => process.exit(0));
  } else {
    // Read and filter recent logs
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    let filtered = lines;
    if (level) {
      filtered = filtered.filter(line => {
        try {
          const entry = JSON.parse(line);
          return entry.level === level;
        } catch {
          // Non-JSON line — check if level string appears in it
          return line.toLowerCase().includes(level.toUpperCase()) ||
                 line.toLowerCase().includes(level.toLowerCase());
        }
      });
    }
    if (moduleName) {
      filtered = filtered.filter(line => {
        try {
          const entry = JSON.parse(line);
          return entry.module === moduleName ||
                 (entry.message && typeof entry.message === 'string' && entry.message.includes(`[${moduleName}]`));
        } catch {
          return line.includes(`[${moduleName}]`);
        }
      });
    }

    // Show last 100 lines
    const toShow = filtered.slice(-100);
    if (toShow.length === 0) {
      console.log('No log lines match the filter.');
    } else {
      for (const line of toShow) {
        console.log(line);
      }
      console.log(`\n--- ${toShow.length} line(s) shown (of ${filtered.length} matching, ${lines.length} total) ---`);
    }
  }
}

// ─── Sessions Command ─────────────────────────────────────────────────────────

async function sessionsCommand(sub: string, opts: string[]): Promise<void> {
  switch (sub) {
    case 'list': {
      // Try to get sessions from dashboard API
      const dashboardUrl = getDashboardUrl(opts);
      if (dashboardUrl) {
        try {
          const response = await fetchViaHttp(`${dashboardUrl}/api/status`, 'GET');
          // The status endpoint may not return sessions directly
          // Try a dedicated sessions endpoint
          console.log('📡 Active Sessions\n');
          if (response && (response as { sessions?: unknown }).sessions) {
            const sessions = (response as { sessions: Array<{ id: string; createdAt?: string; state?: { currentTask?: string }; totalTokens?: number }> }).sessions;
            if (sessions.length === 0) {
              console.log('  No active sessions.');
              return;
            }
            console.log('  ID                                    Created              Task                    Tokens');
            console.log('  ────────────────────────────────────────────────────────────────────────────────');
            for (const s of sessions) {
              console.log(`  ${s.id.padEnd(38)} ${s.createdAt?.slice(0, 19) || '—'.padEnd(20)} ${(s.state?.currentTask || '—').padEnd(24)} ${s.totalTokens || 0}`);
            }
          } else {
            console.log('  (Sessions API not available via dashboard)');
            console.log('  To list sessions, connect to the running engine directly.');
          }
        } catch (err) {
          console.error(`❌ Failed to connect to dashboard: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      } else {
        console.log('📡 Active Sessions\n');
        console.log('  (Dashboard not configured — cannot list sessions remotely)');
        console.log('  Configure a dashboard section in your config file.');
      }
      break;
    }

    case 'show': {
      const sessionId = opts[0];
      if (!sessionId) {
        console.error('Usage: lodestone sessions show <id>');
        process.exit(1);
      }

      // Try dashboard API
      const dashboardUrl = getDashboardUrl(opts);
      if (dashboardUrl) {
        try {
          const response = await fetchViaHttp(`${dashboardUrl}/api/sessions/${sessionId}`, 'GET');
          const session = response as { id: string; createdAt?: string; updatedAt?: string; totalTokens?: number; contextWindow?: number; messages?: unknown[]; state?: { currentTask?: string; progress?: string; mood?: string; nextSteps?: string[]; recentFiles?: string[] }; metadata?: Record<string, unknown>; error?: string };
          if (!session || session.error) {
            console.error(`❌ Session not found: ${sessionId}`);
            process.exit(1);
          }

          console.log('📡 Session Details\n');
          console.log(`  ID:        ${session.id}`);
          console.log(`  Created:   ${session.createdAt}`);
          console.log(`  Updated:   ${session.updatedAt}`);
          console.log(`  Tokens:    ${session.totalTokens} / ${session.contextWindow}`);
          console.log(`  Messages:  ${session.messages?.length || 0}`);
          if (session.state) {
            console.log(`  Task:      ${session.state.currentTask || '—'}`);
            console.log(`  Progress:  ${session.state.progress || '—'}`);
            console.log(`  Mood:      ${session.state.mood || '—'}`);
            if (session.state.nextSteps?.length) {
              console.log(`  Next:      ${session.state.nextSteps.join(', ')}`);
            }
            if (session.state.recentFiles?.length) {
              console.log(`  Files:     ${session.state.recentFiles.join(', ')}`);
            }
          }
          if (session.metadata && Object.keys(session.metadata).length > 0) {
            console.log(`  Metadata:  ${JSON.stringify(session.metadata)}`);
          }
        } catch (err) {
          console.error(`❌ Failed: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      } else {
        console.error('❌ Dashboard not configured — cannot show session details remotely');
        process.exit(1);
      }
      break;
    }

    default:
      console.log('Usage: lodestone sessions <list|show <id>>');
      break;
  }
}

// ─── Migrate Command ──────────────────────────────────────────────────────────

async function migrateCommand(opts: string[]): Promise<void> {
  const statusOnly = opts.includes('--status');
  const workspaceRoot = getWorkspaceRoot(opts);
  const dataDir = resolve(workspaceRoot, 'data');

  // Dynamically import migration system
  const { MigrationSystem, registerBuiltinMigrations } = await import('./migration/index.js');

  const system = new MigrationSystem(dataDir);
  registerBuiltinMigrations(system, dataDir);

  const status = system.getStatus();

  if (statusOnly) {
    console.log('🔮 Migration Status\n');
    console.log(`  Current version:     ${status.currentVersion}`);
    console.log(`  Pending migrations:  ${status.pendingCount}`);
    console.log(`  Total run:           ${status.totalRun}`);
    console.log(`  Last migration:      ${status.lastMigrationDate || '(none)'}`);

    if (status.pending.length > 0) {
      console.log('\n  Pending:');
      for (const p of status.pending) {
        console.log(`    ${p}`);
      }
    }

    const allMigrations = system.listMigrations();
    console.log(`\n  Registered migrations: ${allMigrations.length}`);
    for (const m of allMigrations) {
      const pending = m.version > status.currentVersion ? ' (pending)' : ' ✓';
      console.log(`    v${m.version} — ${m.name}${pending}`);
    }
    return;
  }

  // Run migrations
  console.log('🔮 Lodestone Migration Runner\n');
  console.log(`  Current version: ${status.currentVersion}`);
  console.log(`  Pending: ${status.pendingCount}`);

  if (status.pending.length > 0) {
    console.log('\n  Pending migrations:');
    for (const p of status.pending) {
      console.log(`    ${p}`);
    }
  }

  if (status.pendingCount === 0) {
    console.log('\n✅ No pending migrations. Database is up to date.');
    return;
  }

  console.log('\n  Running migrations...\n');

  const result = await system.runMigrations();

  if (result.success) {
    console.log(`\n✅ All migrations completed successfully!`);
    console.log(`   Version: ${result.fromVersion} → ${result.toVersion}`);
    console.log(`   Executed: ${result.executed} migration(s)`);
    for (const name of result.executedMigrations) {
      console.log(`   ✓ ${name}`);
    }
  } else {
    console.error(`\n❌ Migration failed!`);
    console.error(`   Errors:`);
    for (const err of result.errors) {
      console.error(`   - ${err}`);
    }
    console.error(`   Version remains at: ${result.toVersion}`);
    process.exit(1);
  }
}

// ─── Config Command ───────────────────────────────────────────────────────────

async function configCommand(sub: string, opts: string[]): Promise<void> {
  const configPath = getConfigPath(opts);

  switch (sub) {
    case 'init': {
      const initOpts = parseConfigInitArgs(opts);
      await configInitCommand(initOpts);
      break;
    }

    case 'validate':
    case 'check': {
      if (!existsSync(configPath)) {
        console.error(`❌ Config file not found: ${configPath}`);
        process.exit(1);
      }

      console.log(`Checking config: ${configPath}\n`);

      const validator = new ConfigValidator();
      const result = validator.validateFile(configPath);
      const report = validator.report(result);
      console.log(report);

      if (sub === 'check') {
        // Also check that referenced paths exist
        console.log('\n--- Path checks ---');
        const config = result.config as Record<string, unknown>;
        const paths = ['workspaceRoot', 'identityDir', 'wikiRoot', 'memoryDir'];
        for (const key of paths) {
          const val = config[key];
          if (typeof val === 'string') {
            const resolved = resolve(val);
            const exists = existsSync(resolved);
            console.log(`  ${exists ? '✅' : '❌'} ${key}: ${resolved}`);
          }
        }
      }

      if (!result.valid) {
        process.exit(1);
      }
      break;
    }

    default:
      console.log('Usage: lodestone config <validate|check> [--config <path>]');
      break;
  }
}

// ─── Doctor Command ──────────────────────────────────────────────────────────

async function doctorCommand(): Promise<void> {
  console.log('🔍 Lodestone Doctor — Health Check\n');

  const checks: { name: string; status: string; ok: boolean }[] = [];

  // 1. Node version
  const nodeVersion = process.version;
  checks.push({
    name: 'Node.js',
    status: nodeVersion,
    ok: parseInt(nodeVersion.slice(1)) >= 20,
  });

  // 2. Config file
  const configPath = getConfigPath([]);
  const configExists = existsSync(configPath);
  checks.push({
    name: 'Config file',
    status: configExists ? configPath : 'Not found',
    ok: configExists,
  });

  // 3. Workspace
  const workspace = process.env.LODESTONE_WORKSPACE || './workspace';
  checks.push({
    name: 'Workspace',
    status: workspace,
    ok: existsSync(workspace),
  });

  // 4. Identity
  const identityDir = resolve(workspace, 'workspace');
  checks.push({
    name: 'Identity (IDENTITY.md)',
    status: identityDir,
    ok: existsSync(join(identityDir, 'IDENTITY.md')),
  });

  // 5. Wiki
  const wikiRoot = resolve(workspace, 'memory/wiki');
  checks.push({
    name: 'Wiki root',
    status: wikiRoot,
    ok: existsSync(wikiRoot),
  });

  // 6. Memory DB
  const memoryDir = resolve(workspace, 'data/lancedb');
  checks.push({
    name: 'Memory DB',
    status: memoryDir,
    ok: existsSync(memoryDir),
  });

  // 7. Migration version
  const versionFile = resolve(workspace, 'data/.migration-version');
  let migrationStatus = 'Not initialized';
  let migrationOk = false;
  if (existsSync(versionFile)) {
    const version = readFileSync(versionFile, 'utf-8').trim();
    migrationStatus = `Version ${version}`;
    migrationOk = true;
  }
  checks.push({
    name: 'Migrations',
    status: migrationStatus,
    ok: migrationOk,
  });

  // 8. Running instance
  const pidPath = resolve(workspace, 'data/lodestone.pid');
  let processStatus = 'Not running';
  let processOk = false;
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (pid && isProcessRunning(pid)) {
      processStatus = `Running (PID: ${pid})`;
      processOk = true;
    } else {
      processStatus = 'Stale PID file';
    }
  }
  checks.push({
    name: 'Engine process',
    status: processStatus,
    ok: processOk,
  });

  // Print results
  let allOk = true;
  for (const check of checks) {
    console.log(`  ${check.ok ? '✅' : '❌'} ${check.name}: ${check.status}`);
    if (!check.ok) allOk = false;
  }

  console.log(allOk ? '\n✅ All checks passed.' : '\n❌ Some checks failed. See above.');
  process.exit(allOk ? 0 : 1);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function fetchHealth(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet;
    const req = getter(url, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', (err: Error) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

async function fetchViaHttp(url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requester = url.startsWith('https') ? httpsRequest : httpRequest;
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = requester(options, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          resolve({ response: data });
        }
      });
    });
    req.on('error', (err: Error) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
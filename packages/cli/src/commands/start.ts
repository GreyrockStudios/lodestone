/**
 * `lodestone start` — Boot the Lodestone engine.
 *
 * Loads config, creates engine, registers tools, starts scheduler.
 * This is the same as running main.ts directly but through the CLI.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { LodestoneEngine, type LodestoneConfig } from '@lodestone/core';
import { AgentLoop } from '@lodestone/core';
import { WikiResolveTool, WikiSearchTool } from '@lodestone/core';
import { SmartRetrieveTool } from '@lodestone/core';
import { DecisionLogTool } from '@lodestone/core';
import { ResumeStateTool } from '@lodestone/core';
import { WatchdogTool } from '@lodestone/core';
import { BusinessHoursTool } from '@lodestone/core';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

export function startCommand(): Command {
  const cmd = new Command('start');

  cmd
    .description('Boot the Lodestone engine')
    .option('-c, --config <path>', 'Path to config file', './lodestone.config.yaml')
    .option('-w, --workspace <path>', 'Workspace root directory')
    .option('-m, --model <model>', 'Override default model')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (options) => {
      console.log(chalk.cyan('🔮 Lodestone — Agent Engine'));
      console.log(chalk.dim('─'.repeat(40)));

      try {
        const config = await loadConfig(options);

        console.log(chalk.dim(`Config: ${options.config}`));
        console.log(chalk.dim(`Workspace: ${config.workspaceRoot}`));
        console.log(chalk.dim(`Model: ${config.llm.default.model}`));

        // Create engine
        const engine = new LodestoneEngine(config);
        await engine.memory.init();
        console.log(chalk.green('✓') + ' Memory initialized');

        // Register tools
        const workspaceRoot = config.workspaceRoot;
        engine.registerTool(new WikiResolveTool());
        engine.registerTool(new WikiSearchTool());
        engine.registerTool(new SmartRetrieveTool());
        engine.registerTool(new DecisionLogTool(resolve(workspaceRoot, 'data/decisions.json')));
        engine.registerTool(new ResumeStateTool());
        engine.registerTool(new WatchdogTool());
        engine.registerTool(new BusinessHoursTool());
        console.log(chalk.green('✓') + ' Tools registered: 7 built-in');

        // Register proactive jobs
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
        console.log(chalk.green('✓') + ' Proactive jobs registered: 3');

        // Start engine
        await engine.start();

        // Create session
        const sessionId = engine.createSession();
        console.log(chalk.green('✓') + ` Session: ${sessionId.slice(0, 8)}...`);

        // Load identity
        const identity = await engine.identity.load();
        console.log(chalk.green('✓') + ` Identity: ${identity.identity.name}`);

        // Create agent loop
        const loop = new AgentLoop(engine);

        // Ready
        console.log('');
        console.log(chalk.cyan('🔮 Lodestone is ready.'));
        console.log(chalk.dim(`   Model:    ${config.llm.default.model}`));
        console.log(chalk.dim(`   Provider: ${config.llm.default.type}`));
        console.log(chalk.dim(`   Wiki:     ${config.wikiRoot}`));
        console.log(chalk.dim(`   Memory:   ${config.memoryDir}`));
        console.log('');

        // Graceful shutdown
        const shutdown = async () => {
          console.log(chalk.dim('\nShutting down...'));
          await engine.stop();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Keep alive
        setInterval(() => {}, 24 * 60 * 60 * 1000); // Prevent Node from exiting

      } catch (err) {
        console.error(chalk.red(`\n✗ Failed to start: ${err instanceof Error ? err.message : String(err)}`));
        if (options.verbose && err instanceof Error && err.stack) {
          console.error(chalk.dim(err.stack));
        }
        process.exit(1);
      }
    });

  return cmd;
}

async function loadConfig(options: { config: string; workspace?: string; model?: string }): Promise<LodestoneConfig> {
  const configPath = options.config;

  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw);

    const result: LodestoneConfig = {
      workspaceRoot: options.workspace || config.workspace?.root || process.env.LODESTONE_WORKSPACE || './workspace',
      identityDir: config.identity?.dir || '.',
      wikiRoot: config.memory?.wiki?.path || './memory/wiki',
      memoryDir: config.memory?.vector?.path || './data/lancedb',
      maxConcurrentTools: config.scheduler?.maxConcurrent || 4,
      maxConcurrentJobs: config.scheduler?.maxConcurrent || 4,
      compactionThreshold: config.session?.compactionThreshold || 0.5,
      llm: {
        default: {
          type: config.llm?.default?.type || 'ollama',
          model: options.model || config.llm?.default?.model || 'glm-5.1:cloud',
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
    };

    return result;
  } catch (err) {
    console.error(chalk.red(`Failed to load config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`));
    console.error(chalk.yellow('Using defaults'));
    return {
      workspaceRoot: process.env.LODESTONE_WORKSPACE || './workspace',
      identityDir: '.',
      wikiRoot: './memory/wiki',
      memoryDir: './data/lancedb',
      llm: {
        default: {
          type: 'ollama',
          model: options.model || 'glm-5.1:cloud',
          baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api',
          contextWindow: 128000,
          maxTokens: 8192,
        },
      },
    };
  }
}
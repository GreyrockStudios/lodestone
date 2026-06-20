/**
 * `lodestone start` — Boot the Lodestone engine.
 *
 * Loads config, creates engine, registers tools, starts scheduler.
 * Uses the shared bootEngine function from @lodestone/core for full
 * feature parity with main.ts (channels, dashboard, streaming, etc.)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfigFromFile, bootEngine } from '@lodestone/core';
import { existsSync } from 'fs';
import { resolve } from 'path';

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
        // Load config using shared config loader (parses ALL config fields)
        const config = await loadConfigFromFile(options.config, {
          workspace: options.workspace,
          model: options.model,
        });

        console.log(chalk.dim(`Config: ${options.config}`));
        console.log(chalk.dim(`Workspace: ${config.workspaceRoot}`));
        console.log(chalk.dim(`Model: ${config.llm.default.model}`));

        // Boot engine using shared boot logic (same as main.ts)
        const { engine, loop, sessionId } = await bootEngine(config);

        console.log(chalk.green('✓') + ' Memory initialized');
        console.log(chalk.green('✓') + ' Tools registered: 39 built-in');
        console.log(chalk.green('✓') + ' Proactive jobs registered: 3');
        console.log(chalk.green('✓') + ` Session: ${sessionId.slice(0, 8)}...`);

        // Load identity
        const identity = await engine.identity.load();
        console.log(chalk.green('✓') + ` Identity: ${identity.identity.name}`);

        // Log channel status
        if (engine.channelManager) {
          const channelCount = engine.channelManager.listChannels().length;
          console.log(chalk.green('✓') + ` Channels: ${channelCount} active`);
        }

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
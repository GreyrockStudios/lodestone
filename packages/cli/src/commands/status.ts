/**
 * `lodestone status` — Show engine status information.
 *
 * Displays: identity name, model, tools, sessions, uptime, memory stats.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { existsSync } from 'fs';

export function statusCommand(): Command {
  const cmd = new Command('status');

  cmd
    .description('Show engine status')
    .option('-c, --config <path>', 'Path to config file', './lodestone.config.yaml')
    .option('-w, --workspace <path>', 'Workspace root directory')
    .action(async (options) => {
      try {
        // Load config
        const configPath = options.config;
        let config: any = {};

        try {
          const raw = await readFile(configPath, 'utf-8');
          config = parseYaml(raw);
        } catch {
          console.log(chalk.yellow('⚠') + ' No config file found. Run `lodestone init` first.');
          return;
        }

        const workspaceRoot = options.workspace || config.workspace?.root || './workspace';

        // Load identity
        let identity: any = null;
        try {
          const identityContent = await readFile(resolve(workspaceRoot, 'IDENTITY.md'), 'utf-8');
          // Extract name from identity file
          const nameMatch = identityContent.match(/\*\*Name:\*\*\s*(.+)/i) || identityContent.match(/^#\s+(.+)/m);
          const name = nameMatch ? nameMatch[1].replace(/\*+/g, '').trim() : 'Unknown';
          identity = { name };
        } catch {
          identity = null;
        }

        // Check data directory
        const dataDir = resolve(workspaceRoot, 'data');
        const wikiDir = resolve(workspaceRoot, 'memory', 'wiki');
        const lancedbDir = resolve(workspaceRoot, 'data', 'lancedb');

        // Count wiki pages
        let wikiPageCount = 0;
        try {
          const { readdir } = await import('fs/promises');
          const { stat } = await import('fs/promises');

          async function countMdFiles(dir: string): Promise<number> {
            let count = 0;
            try {
              const entries = await readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  count += await countMdFiles(resolve(dir, entry.name));
                } else if (entry.name.endsWith('.md')) {
                  count++;
                }
              }
            } catch { /* directory doesn't exist yet */ }
            return count;
          }

          wikiPageCount = await countMdFiles(wikiDir);
        } catch {
          wikiPageCount = 0;
        }

        // Check if engine is running (look for PID file or health endpoint)
        const isRunning = false; // TODO: check actual process status

        // Display status
        console.log('');
        console.log(chalk.cyan('🔮 Lodestone Status'));
        console.log(chalk.dim('─'.repeat(40)));

        if (identity) {
          console.log(chalk.dim('  Identity:  ') + chalk.white(identity.name));
        } else {
          console.log(chalk.dim('  Identity:  ') + chalk.yellow('Not configured'));
        }

        console.log(chalk.dim('  Model:     ') + chalk.white(config.llm?.default?.model || 'glm-5.1:cloud'));
        console.log(chalk.dim('  Provider:  ') + chalk.white(config.llm?.default?.type || 'ollama'));
        console.log(chalk.dim('  Workspace: ') + chalk.white(resolve(workspaceRoot)));
        console.log(chalk.dim('  Wiki:      ') + chalk.white(`${wikiPageCount} pages`));
        console.log(chalk.dim('  Engine:    ') + (isRunning ? chalk.green('Running') : chalk.dim('Stopped')));

        // Tools
        const toolNames = [
          'wiki-resolve', 'wiki-search', 'smart-retrieve',
          'decision-log', 'resume-state', 'watchdog', 'business-hours',
        ];
        console.log(chalk.dim('  Tools:     ') + chalk.white(`${toolNames.length} built-in`));
        console.log(chalk.dim('             ') + chalk.dim(toolNames.join(', ')));

        // Proactive jobs
        const jobNames = ['sensorium', 'sleep-cycle', 'drift-detection'];
        console.log(chalk.dim('  Jobs:      ') + chalk.white(`${jobNames.length} scheduled`));
        console.log(chalk.dim('             ') + chalk.dim(jobNames.join(', ')));

        // Config path
        console.log(chalk.dim('  Config:    ') + chalk.white(resolve(configPath)));

        console.log('');

      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}
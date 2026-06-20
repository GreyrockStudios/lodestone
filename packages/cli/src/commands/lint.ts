/**
 * `lodestone lint` — Lint the wiki for broken links, missing frontmatter, orphans, stale pages.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';
import { loadConfigFromFile, WikiStore } from '@lodestone/core';

export function lintCommand(): Command {
  const cmd = new Command('lint');

  cmd
    .description('Lint the wiki — check for broken links, missing frontmatter, orphans, stale pages')
    .option('-w, --workspace <path>', 'Workspace root directory', './workspace')
    .option('--config <path>', 'Config file path', './lodestone.config.yaml')
    .action(async (options) => {
      try {
        const configPath = resolve(options.config);
        const config = await loadConfigFromFile(configPath, { workspace: options.workspace });

        const store = new WikiStore({
          rootDir: config.wikiRoot || resolve(options.workspace, 'memory/wiki'),
          autoIndex: false,
          autoLint: false,
          categories: ['entities', 'concepts', 'decisions', 'projects', 'areas', 'research'],
        });

        console.log(chalk.cyan('\n🔮 Linting wiki...\n'));

        const report = await store.lint();

        if (report.issues.length === 0) {
          console.log(chalk.green('✅ All good — no issues found.'));
        } else {
          for (const issue of report.issues) {
            const icon = issue.severity === 'error' ? chalk.red('❌')
              : issue.severity === 'warn' ? chalk.yellow('⚠️')
              : chalk.blue('ℹ️');
            console.log(`${icon} [${chalk.dim(issue.slug)}] ${issue.message}`);
          }
        }

        console.log(chalk.dim('\n' + '─'.repeat(40)));
        console.log(chalk.dim(`📊 ${report.totalPages} pages, `)
          + chalk.red(`${report.errors} errors`) + chalk.dim(', ')
          + chalk.yellow(`${report.warnings} warnings`) + chalk.dim(', ')
          + chalk.blue(`${report.info} info`));

        process.exit(report.errors > 0 ? 1 : 0);
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}
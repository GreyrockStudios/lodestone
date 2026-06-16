/**
 * `lodestone config` — Configuration management commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function configCommand(): Command {
  const cmd = new Command('config');

  cmd
    .description('Configuration management commands');

  cmd
    .command('show')
    .description('Display current configuration')
    .option('-c, --config <path>', 'Path to config file', './lodestone.config.yaml')
    .action(async (options) => {
      try {
        const configPath = resolve(options.config);
        const content = await readFile(configPath, 'utf-8');
        const config = parseYaml(content);

        console.log('');
        console.log(chalk.cyan('🔮 Lodestone Configuration'));
        console.log(chalk.dim('─'.repeat(40)));
        console.log(chalk.dim(`Config file: ${configPath}`));
        console.log('');

        // Display key sections
        if (config.llm?.default) {
          console.log(chalk.white('LLM:'));
          console.log(chalk.dim(`  Provider:       ${config.llm.default.type || 'ollama'}`));
          console.log(chalk.dim(`  Model:          ${config.llm.default.model || 'glm-5.1:cloud'}`));
          console.log(chalk.dim(`  Context window: ${config.llm.default.contextWindow || 128000}`));
          console.log(chalk.dim(`  Max tokens:     ${config.llm.default.maxTokens || 8192}`));
          if (config.llm.default.baseUrl) {
            console.log(chalk.dim(`  Base URL:       ${config.llm.default.baseUrl}`));
          }
          console.log('');
        }

        if (config.memory) {
          console.log(chalk.white('Memory:'));
          if (config.memory.vectorDb) {
            console.log(chalk.dim(`  Vector DB:      ${config.memory.vectorDb.provider || 'lancedb'}`));
            console.log(chalk.dim(`  Path:           ${config.memory.vectorDb.path || './data/lancedb'}`));
            console.log(chalk.dim(`  Auto-recall:    ${config.memory.vectorDb.autoRecall !== false}`));
            console.log(chalk.dim(`  Auto-capture:   ${config.memory.vectorDb.autoCapture === true}`));
          }
          if (config.memory.wiki) {
            console.log(chalk.dim(`  Wiki path:      ${config.memory.wiki.path || './memory/wiki'}`));
            console.log(chalk.dim(`  Auto-index:     ${config.memory.wiki.autoIndex !== false}`));
            console.log(chalk.dim(`  Auto-lint:      ${config.memory.wiki.autoLint !== false}`));
          }
          console.log('');
        }

        if (config.identity) {
          console.log(chalk.white('Identity:'));
          console.log(chalk.dim(`  Directory:      ${config.identity.dir || '.'}`));
          console.log('');
        }

        if (config.session) {
          console.log(chalk.white('Session:'));
          console.log(chalk.dim(`  Compaction:     ${config.session.compactionThreshold || 0.5}`));
          console.log(chalk.dim(`  Keep recent:    ${config.session.keepRecentCount || 10}`));
          console.log(chalk.dim(`  Max entries:    ${config.session.maxEntries || 200}`));
          console.log('');
        }

        if (config.proactive) {
          console.log(chalk.white('Proactive Systems:'));
          for (const [name, cfg] of Object.entries(config.proactive)) {
            const c = cfg as any;
            console.log(chalk.dim(`  ${name}: ${c.enabled !== false ? 'enabled' : 'disabled'}${c.interval ? ` (every ${c.interval})` : ''}${c.schedule ? ` (${c.schedule})` : ''}`));
          }
          console.log('');
        }

        if (config.logging) {
          console.log(chalk.white('Logging:'));
          console.log(chalk.dim(`  Level:          ${config.logging.level || 'info'}`));
          if (config.logging.file) {
            console.log(chalk.dim(`  File:           ${config.logging.file}`));
          }
          console.log('');
        }

      } catch (err) {
        if ((err as any).code === 'ENOENT') {
          console.log(chalk.yellow('⚠') + ' No config file found. Run `lodestone init` to create one.');
        } else {
          console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        }
        process.exit(1);
      }
    });

  cmd
    .command('set')
    .description('Update a configuration value')
    .argument('<key>', 'Config key (dot notation, e.g. llm.default.model)')
    .argument('<value>', 'New value')
    .option('-c, --config <path>', 'Path to config file', './lodestone.config.yaml')
    .action(async (key, value, options) => {
      try {
        const configPath = resolve(options.config);

        // Read existing config
        let content: string;
        let config: any;
        try {
          content = await readFile(configPath, 'utf-8');
          config = parseYaml(content);
        } catch {
          console.error(chalk.red(`Config file not found: ${configPath}`));
          process.exit(1);
        }

        // Parse value (try JSON for numbers/booleans, else string)
        let parsedValue: any = value;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // Keep as string
        }

        // Set nested key
        const parts = key.split('.');
        let current = config;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!current[parts[i]]) current[parts[i]] = {};
          current = current[parts[i]];
        }
        current[parts[parts.length - 1]] = parsedValue;

        // Write back
        const yaml = stringifyYaml(config);
        await writeFile(configPath, yaml, 'utf-8');

        console.log(chalk.green('✓') + ` Set ${chalk.white(key)} = ${chalk.white(String(parsedValue))}`);

      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}
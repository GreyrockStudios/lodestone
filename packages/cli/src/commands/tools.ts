/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * `lodestone tools` — Tool management commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { LodestoneEngine } from '@lodestone/core';
import { registerBuiltinTools } from '@lodestone/core';
import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';

export function toolsCommand(): Command {
  const cmd = new Command('tools');

  cmd
    .description('Tool management commands');

  cmd
    .command('list')
    .description('List all registered tools')
    .option('-c, --config <path>', 'Path to config file', './lodestone.config.yaml')
    .option('-w, --workspace <path>', 'Workspace root directory')
    .action(async (options) => {
      try {
        // Create a minimal engine to list tools
        const workspace = options.workspace || './workspace';

        const engine = new LodestoneEngine({
          workspaceRoot: resolve(workspace),
          identityDir: resolve(workspace),
          wikiRoot: resolve(workspace, 'memory/wiki'),
          memoryDir: resolve(workspace, 'data/lancedb'),
          llm: {
            default: {
              type: 'ollama',
              model: 'glm-5.2:cloud',
              baseUrl: 'http://127.0.0.1:11434/api',
              contextWindow: 128000,
              maxTokens: 8192,
            },
          },
        });

        // Register all built-in tools
        registerBuiltinTools(engine, resolve(workspace));

        const tools = engine.tools.listDefinitions();

        console.log('');
        console.log(chalk.cyan(`🔮 Lodestone — ${tools.length} Tools Registered`));
        console.log(chalk.dim('─'.repeat(60)));

        for (const tool of tools) {
          console.log(chalk.white(`  ${tool.name}`) + chalk.dim(` [${tool.id}]`));
          console.log(chalk.dim(`    ${tool.description}`));
          console.log(chalk.dim(`    Side effects: ${tool.sideEffects ? 'yes' : 'no'} · Approval: ${tool.requiresApproval ? 'required' : 'auto'}`));
          if (tool.parameters.length > 0) {
            const paramList = tool.parameters
              .map((p: { name: string; required: boolean }) => `${p.name}${p.required ? '*' : ''}`)
              .join(', ');
            console.log(chalk.dim(`    Params: ${paramList}`));
          }
          console.log('');
        }

      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}
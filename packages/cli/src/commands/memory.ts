/**
 * `lodestone memory` — Memory system commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';
import { readdir, stat } from 'fs/promises';

export function memoryCommand(): Command {
  const cmd = new Command('memory');

  cmd
    .description('Memory system commands');

  cmd
    .command('stats')
    .description('Show memory statistics')
    .option('-w, --workspace <path>', 'Workspace root directory', './workspace')
    .action(async (options) => {
      try {
        const workspace = resolve(options.workspace);

        // Count wiki pages
        let wikiPages = 0;
        try {
          wikiPages = await countMdFiles(resolve(workspace, 'memory/wiki'));
        } catch {
          wikiPages = 0;
        }

        // Check vector DB
        let vectorEntries = 0;
        let vectorSizeMB = 0;
        try {
          const lancedbPath = resolve(workspace, 'data/lancedb');
          vectorSizeMB = await getDirSizeMB(lancedbPath);
        } catch {
          vectorSizeMB = 0;
        }

        // Check scratch buffer
        let scratchEntries = 0;
        let scratchSize = 0;
        try {
          const scratchPath = resolve(workspace, 'data/scratch.db');
          const s = await stat(scratchPath);
          scratchSize = s.size;
        } catch {
          scratchSize = 0;
        }

        // Check decisions
        let decisionCount = 0;
        try {
          const decPath = resolve(workspace, 'data/decisions.json');
          const content = await import('fs/promises').then(fs => fs.readFile(decPath, 'utf-8'));
          const data = JSON.parse(content);
          decisionCount = Array.isArray(data) ? data.length : Object.keys(data).length;
        } catch {
          decisionCount = 0;
        }

        console.log('');
        console.log(chalk.cyan('🔮 Memory Statistics'));
        console.log(chalk.dim('─'.repeat(40)));
        console.log(chalk.dim('  Wiki pages:     ') + chalk.white(`${wikiPages} pages`));
        console.log(chalk.dim('  Vector DB:      ') + chalk.white(`${vectorSizeMB > 0 ? vectorSizeMB.toFixed(1) + ' MB' : 'Not initialized'}`));
        console.log(chalk.dim('  Scratch buffer: ') + chalk.white(`${scratchSize > 0 ? formatBytes(scratchSize) : 'Empty'}`));
        console.log(chalk.dim('  Decisions:      ') + chalk.white(`${decisionCount} recorded`));
        console.log('');

      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}

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
  } catch {
    // Directory doesn't exist yet
  }
  return count;
}

async function getDirSizeMB(dir: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirSizeMB(fullPath);
      } else {
        try {
          const s = await stat(fullPath);
          totalSize += s.size;
        } catch { /* skip */ }
      }
    }
  } catch { /* doesn't exist */ }
  return totalSize / (1024 * 1024);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * `lodestone chat` — Start the TUI chat interface.
 *
 * Launches the pi-tui based terminal UI for interactive chat
 * with the Lodestone agent.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';

export function chatCommand(): Command {
  const cmd = new Command('chat');

  cmd
    .description('Start the TUI chat interface')
    .option('-w, --workspace <path>', 'Workspace root directory', '/tmp/lodestone-test/workspace')
    .option('-m, --model <model>', 'Override default model')
    .action(async (options) => {
      console.log(chalk.cyan('\n🔮 Starting Lodestone TUI Chat...\n'));
      console.log(chalk.dim('This command launches an interactive terminal UI.'));
      console.log(chalk.dim('The TUI requires a TTY terminal — it cannot run in piped/CI mode.'));
      console.log(chalk.dim(''));

      // Dynamically import and run the TUI
      // This avoids loading the heavy pi-tui dependency unless actually using chat
      try {
        const workspace = resolve(options.workspace);
        const model = options.model || process.env.LODESTONE_MODEL || 'glm-5.1:cloud';

        // Set env vars that the TUI chat will use
        process.env.LODESTONE_WORKSPACE = workspace;
        process.env.LODESTONE_MODEL = model;

        // Import the TUI chat — it's self-contained
        const tuiPath = resolve(__dirname, '../../../core/dist/test/tui-chat.js');

        try {
          await import(tuiPath);
        } catch {
          // If direct import fails, try the source path
          console.log(chalk.yellow('TUI module not found. Building first...'));
          console.log(chalk.dim('Run: npm run build --workspace=@lodestone/core'));
          process.exit(1);
        }

      } catch (err) {
        console.error(chalk.red(`Failed to start TUI: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}
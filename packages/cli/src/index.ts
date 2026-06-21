#!/usr/bin/env node
/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */

/**
 * Lodestone CLI — Command-line interface for the Lodestone agent engine.
 *
 * Usage:
 *   lodestone init          Interactive workspace setup wizard
 *   lodestone start         Boot the engine
 *   lodestone status        Show engine status
 *   lodestone chat          Start TUI chat interface
 *   lodestone tools list    List registered tools
 *   lodestone memory stats  Show memory statistics
 *   lodestone config show   Display current config
 *   lodestone config set    Update a config value
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { chatCommand } from './commands/chat.js';
import { toolsCommand } from './commands/tools.js';
import { memoryCommand } from './commands/memory.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { lintCommand } from './commands/lint.js';

const program = new Command();

program
  .name('lodestone')
  .description('Lodestone — standalone agent engine with memory, self-improvement, and proactivity')
  .version('0.1.0');

// Register commands
program.addCommand(initCommand());
program.addCommand(startCommand());
program.addCommand(statusCommand());
program.addCommand(chatCommand());
program.addCommand(toolsCommand());
program.addCommand(memoryCommand());
program.addCommand(configCommand());
program.addCommand(doctorCommand());
program.addCommand(lintCommand());

program.parse();
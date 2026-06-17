/**
 * Lodestone — TUI Chat Entry Point
 *
 * Thin wrapper that starts the TUI chat interface.
 * All logic lives in the tui-chat/ module.
 */

import { startTUI } from '../tui-chat/index.js';

startTUI().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
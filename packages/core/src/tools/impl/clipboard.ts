/**
 * Lodestone Tool — Clipboard
 *
 * Read and write the system clipboard.
 * Uses pbpaste/pbcopy on macOS, xclip on Linux.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type ClipboardAction = 'read' | 'write' | 'clear';

export class ClipboardTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'clipboard',
    name: 'Clipboard',
    description: 'Read, write, or clear the system clipboard. Uses pbpaste/pbcopy (macOS) or xclip (Linux).',
    parameters: [
      { name: 'action', type: 'string', description: 'Clipboard action: read, write, or clear', required: true, enum: ['read', 'write', 'clear'] },
      { name: 'text', type: 'string', description: 'Text to write to clipboard (required for write action)', required: false },
    ],
    sideEffects: true, // Set to true overall; execute() adjusts per-action
    requiresApproval: false,
    timeout: 5000,
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params.action as ClipboardAction;
    const text = params.text as string | undefined;
    const start = Date.now();

    if (!action) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: action',
        error: 'action is required (read, write, or clear)',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const platform = process.platform;

    try {
      switch (action) {
        case 'read':
          return await this.readClipboard(platform, start);

        case 'write':
          if (text === undefined || text === null) {
            return {
              success: false,
              data: null,
              summary: 'Missing required parameter: text',
              error: 'text is required for write action',
              durationMs: Date.now() - start,
              includeInContext: false,
            };
          }
          return await this.writeClipboard(text, platform, start);

        case 'clear':
          return await this.writeClipboard('', platform, start, true);

        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: 'Action must be read, write, or clear',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Clipboard ${action} failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Read ───────────────────────────────────────────────────────────────────

  private async readClipboard(platform: string, start: number): Promise<ToolResult> {
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'pbpaste';
      args = [];
    } else {
      cmd = 'xclip';
      args = ['-selection', 'clipboard', '-o'];
    }

    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 4000, maxBuffer: 1024 * 1024 });
      return {
        success: true,
        data: { text: stdout },
        summary: stdout.length > 0
          ? `Read ${stdout.length} chars from clipboard`
          : 'Clipboard is empty',
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      // xclip might not be installed on Linux
      if (platform !== 'darwin') {
        return {
          success: false,
          data: null,
          summary: 'Clipboard read failed. Is xclip installed?',
          error: `Failed to read clipboard: ${err}. Install xclip: apt install xclip`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      throw err;
    }
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  private async writeClipboard(text: string, platform: string, start: number, isClear = false): Promise<ToolResult> {
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'pbcopy';
      args = [];
    } else {
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
    }

    try {
      const child = execFile(cmd, args, { timeout: 4000 });
      child.stdin?.write(text);
      child.stdin?.end();

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Process exited with code ${code}`));
        });
        child.on('error', reject);
      });

      return {
        success: true,
        data: { success: true },
        summary: isClear ? 'Clipboard cleared' : `Wrote ${text.length} chars to clipboard`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    } catch (err) {
      if (platform !== 'darwin') {
        return {
          success: false,
          data: null,
          summary: 'Clipboard write failed. Is xclip installed?',
          error: `Failed to write clipboard: ${err}. Install xclip: apt install xclip`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      throw err;
    }
  }
}
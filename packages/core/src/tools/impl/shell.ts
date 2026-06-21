/**
 * Lodestone Tool — Shell Execution
 *
 * Execute shell commands sandboxed to the workspace root.
 * Captures stdout, stderr, exit code, and duration.
 */

import { exec } from 'child_process';
import { resolve, relative, isAbsolute } from 'path';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface ShellExecConfig {
  /** Workspace root — shell cwd is sandboxed to this directory */
  workspaceRoot: string;
  /** Default timeout in ms (default: 30000) */
  defaultTimeout?: number;
  /** Max output size in bytes (default: 100KB) */
  maxOutput?: number;
}

export class ShellExecTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'shell',
    name: 'Shell Execution',
    description: 'Execute a shell command sandboxed to the workspace root. Returns stdout, stderr, exit code, and duration.',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command to execute', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory (relative to workspace root)', required: false },
      { name: 'timeoutMs', type: 'number', description: 'Timeout in ms (default: 30000). Process is killed if exceeded.', required: false, default: 30000 },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 60000,
  };

  private config: Required<ShellExecConfig>;

  constructor(config: ShellExecConfig) {
    this.config = {
      workspaceRoot: config.workspaceRoot,
      defaultTimeout: config.defaultTimeout ?? 30000,
      maxOutput: config.maxOutput ?? 100 * 1024,
    };
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const command = params.command as string;
    const cwdParam = (params.cwd as string) || '.';
    const timeoutMs = (params.timeoutMs as number) || (params.timeout as number) || this.config.defaultTimeout;
    const start = Date.now();

    // Sandbox cwd to workspace root
    const cwd = this.sandboxCwd(cwdParam);
    if (!cwd) {
      return {
        success: false,
        data: null,
        summary: `Working directory escapes workspace: ${cwdParam}`,
        error: 'Path traversal denied',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    try {
      const { stdout, stderr, exitCode, timedOut } = await this.runCommand(command, cwd, timeoutMs);

      const truncate = (s: string): string =>
        s.length > this.config.maxOutput
          ? s.slice(0, this.config.maxOutput) + '\n...[truncated]'
          : s;

      if (timedOut) {
        return {
          success: false,
          data: {
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            exitCode: null,
            timedOut: true,
            durationMs: Date.now() - start,
          },
          summary: `Command timed out after ${timeoutMs}ms: \`${command.slice(0, 100)}\``,
          error: `Timeout: command \`${command.slice(0, 80)}\` exceeded ${timeoutMs}ms limit`,
          durationMs: Date.now() - start,
          includeInContext: true,
        };
      }

      const cmdPreview = command.length > 80 ? command.slice(0, 77) + '...' : command;
      const trimmedStderr = stderr.trim();

      return {
        success: exitCode === 0,
        data: {
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode,
          timedOut: false,
          durationMs: Date.now() - start,
        },
        summary: exitCode === 0
          ? `\`${cmdPreview}\` succeeded (exit 0, ${Date.now() - start}ms)`
          : `\`${cmdPreview}\` failed with exit code ${exitCode}${trimmedStderr ? ': ' + trimmedStderr.slice(0, 150) : ''}`,
        error: exitCode === 0 ? undefined : `Command \`${cmdPreview}\` exited with code ${exitCode}${trimmedStderr ? ' — ' + trimmedStderr.slice(0, 200) : ''}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      const cmdPreview = command.length > 80 ? command.slice(0, 77) + '...' : command;
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        summary: `\`${cmdPreview}\` threw an error: ${errMsg}`,
        error: `Shell execution error for \`${cmdPreview}\`: ${errMsg}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  /** Resolve cwd relative to workspace, rejecting escapes */
  private sandboxCwd(cwdPath: string): string | null {
    const resolved = isAbsolute(cwdPath) ? cwdPath : resolve(this.config.workspaceRoot, cwdPath);
    const rel = relative(this.config.workspaceRoot, resolved);
    if (rel.startsWith('..')) return null;
    return resolved;
  }

  private runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolvePromise) => {
      const child = exec(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        // Node sets err.killed=true when the process was killed by timeout
        const timedOut = !!err && (err as { killed?: boolean }).killed === true;
        resolvePromise({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: timedOut ? -1 : (err ? (err as { code?: number }).code ?? 1 : 0),
          timedOut,
        });
      });

      // Safety: ensure the child process is cleaned up if the promise is never settled
      child.on('error', () => {
        resolvePromise({
          stdout: '',
          stderr: 'Failed to spawn process',
          exitCode: -1,
          timedOut: false,
        });
      });
    });
  }
}
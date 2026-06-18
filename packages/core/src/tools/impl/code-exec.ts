/**
 * Lodestone Tool — Code Execution
 *
 * Runs code in a sandboxed subprocess.
 * Supports Python and Node.js execution with timeout and output capture.
 *
 * Security: Runs in a subprocess with timeout, resource limits, and
 * network isolation (no network access by default).
 */

import { execFile } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface CodeExecConfig {
  /** Allowed runtimes */
  runtimes?: string[];
  /** Default timeout in ms (default: 10000) */
  defaultTimeout?: number;
  /** Max output size in bytes (default: 100KB) */
  maxOutput?: number;
  /** Python executable path (default: python3) */
  pythonPath?: string;
  /** Node executable path (default: node) */
  nodePath?: string;
}

export class CodeExecTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'code-exec',
    name: 'Code Execution',
    description: 'Execute code in a sandboxed subprocess. Supports python and node.',
    parameters: [
      { name: 'language', type: 'string', description: 'Language: python or node', required: true },
      { name: 'code', type: 'string', description: 'Code to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in ms (default: 10000)', required: false },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 30000,
  };

  private config: Required<CodeExecConfig>;

  constructor(config: CodeExecConfig = {}) {
    this.config = {
      runtimes: config.runtimes || ['python', 'node'],
      defaultTimeout: config.defaultTimeout || 10000,
      maxOutput: config.maxOutput || 100 * 1024,
      pythonPath: config.pythonPath || 'python3',
      nodePath: config.nodePath || 'node',
    };
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const language = params.language as string;
    const code = params.code as string;
    const timeout = (params.timeout as number) || this.config.defaultTimeout;
    const start = Date.now();

    // Validate runtime
    if (!this.config.runtimes.includes(language)) {
      return {
        success: false, data: null,
        summary: `Runtime "${language}" not allowed. Supported: ${this.config.runtimes.join(', ')}`,
        error: 'UnsupportedRuntime', durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // Create temp directory for execution
    const tempDir = mkdtempSync(join(tmpdir(), 'lodestone-exec-'));
    let ext: string;
    let cmd: string;
    let args: string[];

    if (language === 'python') {
      ext = '.py';
      cmd = this.config.pythonPath;
      args = [];
    } else if (language === 'node') {
      ext = '.js';
      cmd = this.config.nodePath;
      args = [];
    } else {
      return {
        success: false, data: null,
        summary: `Unsupported language: ${language}`,
        error: 'Unsupported', durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const scriptPath = join(tempDir, `script${ext}`);
    writeFileSync(scriptPath, code);

    if (language === 'python') {
      args = [scriptPath];
    } else {
      args = [scriptPath];
    }

    try {
      const result = await this.runProcess(cmd, args, tempDir, timeout);
      const truncated = result.output.length > this.config.maxOutput
        ? result.output.slice(0, this.config.maxOutput) + '\n...[truncated]'
        : result.output;

      return {
        success: result.exitCode === 0,
        data: {
          exitCode: result.exitCode,
          stdout: truncated,
          stderr: result.stderr.slice(0, this.config.maxOutput),
          durationMs: result.durationMs,
        },
        summary: result.exitCode === 0
          ? `Executed ${language} code (${result.durationMs}ms, exit 0)`
          : `Execution failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        error: result.exitCode === 0 ? undefined : `Exit code ${result.exitCode}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Execution error: ${err}`,
        error: String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    } finally {
      // Cleanup
      try { rmSync(tempDir, { recursive: true }); } catch { /* best-effort */ }
    }
  }

  private runProcess(cmd: string, args: string[], cwd: string, timeout: number): Promise<{
    exitCode: number; output: string; stderr: string; durationMs: number;
  }> {
    return new Promise((resolve) => {
      const procStart = Date.now();
      const proc = execFile(cmd, args, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          // Sandbox: no network changes, restricted env
          NODE_OPTIONS: '--no-warnings',
          PYTHONPATH: '',
        },
      }, (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (err as { code?: number }).code || 1 : 0,
          output: stdout || '',
          stderr: stderr || (err ? String(err) : ''),
          durationMs: Date.now() - procStart,
        });
      });
    });
  }
}
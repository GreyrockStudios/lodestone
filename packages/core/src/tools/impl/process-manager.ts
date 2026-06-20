/**
 * Lodestone Tool — Process Manager
 *
 * Manage background processes: start, stop, list, logs, poll.
 * Tracks spawned processes in an internal Map with ring-buffered stdout/stderr.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

interface TrackedProcess {
  pid: number;
  command: string;
  process: ChildProcess;
  stdoutBuffer: string[];
  stderrBuffer: string[];
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

export class ProcessManagerTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'process-manager',
    name: 'Process Manager',
    description: 'Manage background processes. Actions: start, stop, list, logs, poll. Tracks PIDs and maintains output buffers.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: start, stop, list, logs, or poll', required: true, enum: ['start', 'stop', 'list', 'logs', 'poll'] },
      { name: 'command', type: 'string', description: 'Command to start (for action: start)', required: false },
      { name: 'pid', type: 'number', description: 'Process ID (for action: stop, logs, poll)', required: false },
      { name: 'lines', type: 'number', description: 'Number of log lines to return (for action: logs, default: 50)', required: false, default: 50 },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 10000,
  };

  /** Static map to track processes across tool calls */
  private static processes: Map<number, TrackedProcess> = new Map();
  private static pidCounter: number = 0;

  private readonly maxBufferLines = 1000;

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'start':
          return await this.start(params.command as string, start);
        case 'stop':
          return await this.stop(params.pid as number, start);
        case 'list':
          return this.list(start);
        case 'logs':
          return this.logs(params.pid as number, (params.lines as number) || 50, start);
        case 'poll':
          return this.poll(params.pid as number, start);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: start, stop, list, logs, poll',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Process manager error: ${err}`,
        error: String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  private async start(command: string, start: number): Promise<ToolResult> {
    if (!command) {
      return {
        success: false,
        data: null,
        summary: 'No command provided for start',
        error: 'MissingCommand',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const child = spawn(cmd, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const pid = child.pid ?? ProcessManagerTool.pidCounter++;
    const tracked: TrackedProcess = {
      pid,
      command,
      process: child,
      stdoutBuffer: [],
      stderrBuffer: [],
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
    };

    // Attach listeners for output buffering
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          tracked.stdoutBuffer.push(line);
          if (tracked.stdoutBuffer.length > this.maxBufferLines) {
            tracked.stdoutBuffer.shift();
          }
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          tracked.stderrBuffer.push(line);
          if (tracked.stderrBuffer.length > this.maxBufferLines) {
            tracked.stderrBuffer.shift();
          }
        }
      });
    }

    child.on('exit', (code) => {
      tracked.exited = true;
      tracked.exitCode = code;
    });

    // Detach so process survives
    child.unref();

    ProcessManagerTool.processes.set(pid, tracked);

    return {
      success: true,
      data: { pid, command, startedAt: tracked.startedAt },
      summary: `Started process ${pid}: ${command}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async stop(pid: number, start: number): Promise<ToolResult> {
    const tracked = ProcessManagerTool.processes.get(pid);
    if (!tracked) {
      return {
        success: false,
        data: null,
        summary: `Process ${pid} not found`,
        error: 'ProcessNotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (tracked.exited) {
      return {
        success: true,
        data: { pid, alreadyExited: true, exitCode: tracked.exitCode },
        summary: `Process ${pid} already exited (code ${tracked.exitCode})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    // Send SIGTERM
    tracked.process.kill('SIGTERM');

    // Wait 5s, then SIGKILL
    await new Promise((r) => setTimeout(r, 5000));

    if (!tracked.exited) {
      try {
        tracked.process.kill('SIGKILL');
      } catch {
        // Process may have exited between checks
      }
    }

    ProcessManagerTool.processes.delete(pid);

    return {
      success: true,
      data: { pid, signal: tracked.exited ? 'SIGTERM' : 'SIGKILL' },
      summary: `Stopped process ${pid}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private list(start: number): ToolResult {
    const processes = Array.from(ProcessManagerTool.processes.values()).map((p) => ({
      pid: p.pid,
      command: p.command,
      startedAt: p.startedAt,
      running: !p.exited,
      exitCode: p.exitCode,
      stdoutLines: p.stdoutBuffer.length,
      stderrLines: p.stderrBuffer.length,
    }));

    return {
      success: true,
      data: { processes, count: processes.length },
      summary: `${processes.length} process(es) tracked`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private logs(pid: number, lines: number, start: number): ToolResult {
    const tracked = ProcessManagerTool.processes.get(pid);
    if (!tracked) {
      return {
        success: false,
        data: null,
        summary: `Process ${pid} not found`,
        error: 'ProcessNotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const stdout = tracked.stdoutBuffer.slice(-lines);
    const stderr = tracked.stderrBuffer.slice(-lines);

    return {
      success: true,
      data: {
        pid,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        stdoutLines: stdout.length,
        stderrLines: stderr.length,
      },
      summary: `Retrieved ${stdout.length} stdout + ${stderr.length} stderr lines for PID ${pid}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private poll(pid: number, start: number): ToolResult {
    const tracked = ProcessManagerTool.processes.get(pid);
    if (!tracked) {
      return {
        success: false,
        data: null,
        summary: `Process ${pid} not found`,
        error: 'ProcessNotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    return {
      success: true,
      data: {
        pid,
        running: !tracked.exited,
        exitCode: tracked.exitCode,
        uptimeMs: Date.now() - tracked.startedAt,
      },
      summary: `Process ${pid} is ${tracked.exited ? 'exited' : 'running'} (${tracked.exitCode ?? 'n/a'})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }
}
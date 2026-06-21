/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — Process Manager
 *
 * Manage background processes: start, stop, list, logs, poll, killGroup.
 * Tracks spawned processes in an internal Map with ring-buffered stdout/stderr.
 * Supports process group management for killing entire process trees.
 */

import { spawn, type ChildProcess } from 'child_process';
import process from 'process';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

interface TrackedProcess {
  pid: number;
  pgid: number | null;
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
    description: 'Manage background processes. Actions: start, stop, list, logs, poll, killGroup. Tracks PIDs and maintains output buffers. Supports process group killing.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: start, stop, list, logs, poll, killGroup', required: true, enum: ['start', 'stop', 'list', 'logs', 'poll', 'killGroup'] },
      { name: 'command', type: 'string', description: 'Command to start (for action: start)', required: false },
      { name: 'pid', type: 'number', description: 'Process ID (for action: stop, logs, poll)', required: false },
      { name: 'groupId', type: 'number', description: 'Process group ID to kill (for action: killGroup)', required: false },
      { name: 'signal', type: 'string', description: 'Signal to send: SIGTERM (default), SIGKILL, SIGINT, SIGHUP (for action: stop, killGroup)', required: false, enum: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] },
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
          return await this.stop(params.pid as number, start, params.signal as string | undefined);
        case 'list':
          return this.list(start);
        case 'logs':
          return this.logs(params.pid as number, (params.lines as number) || 50, start);
        case 'poll':
          return this.poll(params.pid as number, start);
        case 'killGroup':
          return await this.killGroup(params.groupId as number, start, params.signal as string | undefined);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action '${action}'`,
            error: `Valid actions: start, stop, list, logs, poll, killGroup. Received: '${action}'`,
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Process manager error: ${err}`,
        error: `UnexpectedError: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  private async start(command: string, start: number): Promise<ToolResult> {
    if (!command || command.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: 'Cannot start process: no command provided',
        error: 'MissingCommand: command parameter is required for action=start. Example: {"action":"start","command":"echo hello"}',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Failed to spawn '${cmd}': ${err instanceof Error ? err.message : String(err)}`,
        error: `SpawnFailed: could not start command '${command}'. Check that the binary exists and is executable.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const pid = child.pid ?? ProcessManagerTool.pidCounter++;
    // For detached processes, the child becomes its own process group leader
    // so pgid equals the child's pid
    const pgid = child.pid ?? null;

    const tracked: TrackedProcess = {
      pid,
      pgid,
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
      data: { pid, pgid, command, startedAt: tracked.startedAt },
      summary: `Started process ${pid} (group ${pgid}): ${command}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async stop(pid: number, start: number, signal?: string): Promise<ToolResult> {
    if (!pid || typeof pid !== 'number') {
      return {
        success: false,
        data: null,
        summary: `Cannot stop process: invalid PID '${pid}'`,
        error: `InvalidPid: pid parameter is required and must be a number for action=stop. Received: '${pid}'.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const tracked = ProcessManagerTool.processes.get(pid);
    if (!tracked) {
      return {
        success: false,
        data: null,
        summary: `Cannot stop process: PID ${pid} is not tracked by this manager`,
        error: `ProcessNotFound: no process with PID ${pid} is currently tracked. Use action=list to see tracked processes.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (tracked.exited) {
      return {
        success: true,
        data: { pid, alreadyExited: true, exitCode: tracked.exitCode },
        summary: `Process ${pid} already exited with code ${tracked.exitCode} — no action needed`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    const sig = signal ?? 'SIGTERM';

    // Send the signal
    try {
      tracked.process.kill(sig as NodeJS.Signals);
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Failed to send ${sig} to process ${pid}: ${err instanceof Error ? err.message : String(err)}`,
        error: `KillFailed: could not send signal ${sig} to PID ${pid}. The process may have already exited.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // If SIGTERM, wait 5s then escalate to SIGKILL
    if (sig === 'SIGTERM') {
      await new Promise((r) => setTimeout(r, 5000));

      if (!tracked.exited) {
        try {
          tracked.process.kill('SIGKILL');
        } catch {
          // Process may have exited between checks
        }
      }
    }

    ProcessManagerTool.processes.delete(pid);

    return {
      success: true,
      data: { pid, signal: tracked.exited ? sig : 'SIGKILL' },
      summary: `Stopped process ${pid} (signal: ${tracked.exited ? sig : 'SIGKILL (escalated)'})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private list(start: number): ToolResult {
    const processes = Array.from(ProcessManagerTool.processes.values()).map((p) => ({
      pid: p.pid,
      pgid: p.pgid,
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
    if (!pid || typeof pid !== 'number') {
      return {
        success: false,
        data: null,
        summary: `Cannot get logs: invalid PID '${pid}'`,
        error: `InvalidPid: pid parameter is required for action=logs. Received: '${pid}'.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const tracked = ProcessManagerTool.processes.get(pid);
    if (!tracked) {
      return {
        success: false,
        data: null,
        summary: `Cannot get logs: PID ${pid} is not tracked`,
        error: `ProcessNotFound: no process with PID ${pid} is tracked. Use action=list to see tracked processes.`,
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
    if (!pid || typeof pid !== 'number') {
      return {
        success: false,
        data: null,
        summary: `Cannot poll: invalid PID '${pid}'`,
        error: `InvalidPid: pid parameter is required for action=poll. Received: '${pid}'.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const tracked = ProcessManagerTool.processes.get(pid);
    if (!tracked) {
      return {
        success: false,
        data: null,
        summary: `Cannot poll: PID ${pid} is not tracked`,
        error: `ProcessNotFound: no process with PID ${pid} is tracked. Use action=list to see tracked processes.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const uptimeMs = Date.now() - tracked.startedAt;
    return {
      success: true,
      data: {
        pid,
        running: !tracked.exited,
        exitCode: tracked.exitCode,
        uptimeMs,
      },
      summary: `Process ${pid}: ${tracked.exited ? `exited (code ${tracked.exitCode ?? 'n/a'})` : `running (${Math.round(uptimeMs / 1000)}s uptime)`}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  /**
   * Kill an entire process group by sending a signal to the negative PID (pgid).
   * This kills the group leader and all child processes in the group.
   */
  private async killGroup(groupId: number, start: number, signal?: string): Promise<ToolResult> {
    if (!groupId || typeof groupId !== 'number') {
      return {
        success: false,
        data: null,
        summary: `Cannot kill group: invalid groupId '${groupId}'`,
        error: `InvalidGroupId: groupId parameter is required and must be a number for action=killGroup. Received: '${groupId}'.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const sig = signal ?? 'SIGTERM';

    // Find all tracked processes belonging to this group
    const groupProcesses = Array.from(ProcessManagerTool.processes.values()).filter(
      (p) => p.pgid === groupId,
    );

    if (groupProcesses.length === 0) {
      // Still attempt to kill the group via OS — the process may not be tracked
      try {
        process.kill(-groupId, sig as NodeJS.Signals);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          data: null,
          summary: `Failed to kill process group ${groupId}: ${errMsg}`,
          error: `GroupKillFailed: no tracked processes in group ${groupId}, and OS kill failed: ${errMsg}. The group may not exist or you may lack permissions.`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      return {
        success: true,
        data: { groupId, signal: sig, trackedKilled: 0, osKilled: true },
        summary: `Killed process group ${groupId} via OS (no tracked processes in this group)`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    // Send signal to the entire process group via negative PID
    let killed = 0;
    let errors: string[] = [];

    try {
      process.kill(-groupId, sig as NodeJS.Signals);
      killed = groupProcesses.length;
    } catch (err) {
      // Fallback: kill each process individually
      for (const p of groupProcesses) {
        try {
          p.process.kill(sig as NodeJS.Signals);
          killed++;
        } catch (e) {
          errors.push(`PID ${p.pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // If SIGTERM, wait then escalate to SIGKILL for stragglers
    if (sig === 'SIGTERM') {
      await new Promise((r) => setTimeout(r, 5000));

      for (const p of groupProcesses) {
        if (!p.exited) {
          try {
            process.kill(-groupId, 'SIGKILL');
          } catch {
            try {
              p.process.kill('SIGKILL');
            } catch {
              // already dead
            }
          }
        }
        ProcessManagerTool.processes.delete(p.pid);
      }
    } else {
      for (const p of groupProcesses) {
        ProcessManagerTool.processes.delete(p.pid);
      }
    }

    const summary = errors.length > 0
      ? `Killed ${killed}/${groupProcesses.length} processes in group ${groupId} (${errors.length} errors)`
      : `Killed ${killed} process(es) in group ${groupId} (signal: ${sig})`;

    return {
      success: errors.length === 0,
      data: {
        groupId,
        signal: sig,
        trackedKilled: killed,
        totalInGroup: groupProcesses.length,
        pids: groupProcesses.map((p) => p.pid),
        ...(errors.length > 0 ? { errors } : {}),
      },
      summary,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }
}
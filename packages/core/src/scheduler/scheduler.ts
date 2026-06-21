/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Scheduler
 *
 * Proactive scheduling system. Manages cron-like jobs that make the agent
 * think and act even when no one is talking to it.
 *
 * Jobs: sensorium, sleep cycle, drift detection, RBT diagnosis,
 *       morning brief, wiki lint, inbox processing, etc.
 */

import { EventEmitter } from 'events';

// ─── Job Types ──────────────────────────────────────────────────────────────

export type JobSchedule =
  | { kind: 'cron'; expr: string; tz?: string }      // cron expression
  | { kind: 'interval'; everyMs: number }              // run every N ms
  | { kind: 'at'; at: string }                          // run once at ISO timestamp

export interface JobConfig {
  /** Unique job ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this job does (injected into the agent's context) */
  description: string;
  /** Schedule definition */
  schedule: JobSchedule;
  /** Whether this job is enabled */
  enabled?: boolean;
  /** Maximum runtime in seconds before timeout */
  timeoutSeconds?: number;
  /** Which tools this job can use (null = all) */
  toolsAllow?: string[];
  /** Delivery channel for results */
  delivery?: {
    mode: 'none' | 'announce' | 'webhook';
    channel?: string;
    to?: string;
  };
}

export interface JobResult {
  jobId: string;
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary?: string;
  error?: string;
}

export interface JobState {
  config: JobConfig;
  lastRunAt?: string;
  lastResult?: JobResult;
  consecutiveErrors: number;
  nextRunAt?: string;
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

export class Scheduler extends EventEmitter {
  private jobs: Map<string, JobState> = new Map();
  private timers: Map<string, NodeJS.Timeout | ReturnType<typeof setTimeout>> = new Map();
  private running: Set<string> = new Set();
  private maxConcurrent: number;

  constructor(maxConcurrent = 4) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  /** Register a new job */
  register(config: JobConfig): void {
    const state: JobState = {
      config: { enabled: true, timeoutSeconds: 300, ...config },
      consecutiveErrors: 0,
    };
    this.jobs.set(config.id, state);

    if (config.enabled !== false) {
      this.scheduleNext(config.id);
    }
  }

  /** Unregister a job */
  unregister(jobId: string): void {
    this.cancelTimer(jobId);
    this.jobs.delete(jobId);
  }

  /** Enable a job */
  enable(jobId: string): void {
    const state = this.jobs.get(jobId);
    if (state) {
      state.config.enabled = true;
      this.scheduleNext(jobId);
    }
  }

  /** Disable a job */
  disable(jobId: string): void {
    const state = this.jobs.get(jobId);
    if (state) {
      state.config.enabled = false;
      this.cancelTimer(jobId);
    }
  }

  /** Run a job immediately */
  async runNow(jobId: string): Promise<JobResult> {
    const state = this.jobs.get(jobId);
    if (!state) {
      return {
        jobId,
        status: 'error',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        error: `Unknown job: ${jobId}`,
      };
    }

    // Check concurrency
    if (this.running.size >= this.maxConcurrent) {
      return {
        jobId,
        status: 'skipped',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        summary: 'Max concurrent jobs reached',
      };
    }

    this.running.add(jobId);
    const startedAt = new Date().toISOString();

    this.emit('job:start', { jobId, name: state.config.name });

    try {
      // The actual job execution is handled by the engine
      // This just emits events and manages state
      const result: JobResult = {
        jobId,
        status: 'ok',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        summary: 'Job triggered',
      };

      state.lastRunAt = startedAt;
      state.lastResult = result;
      state.consecutiveErrors = 0;

      this.emit('job:complete', { jobId, result });
      this.scheduleNext(jobId);

      return result;
    } catch (err) {
      const result: JobResult = {
        jobId,
        status: 'error',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };

      state.lastResult = result;
      state.consecutiveErrors++;

      this.emit('job:error', { jobId, error: result.error });
      this.scheduleNext(jobId);

      return result;
    } finally {
      this.running.delete(jobId);
    }
  }

  /** Get all job states */
  list(): JobState[] {
    return Array.from(this.jobs.values());
  }

  /** Get a specific job state */
  getState(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  /** Stop all scheduled jobs */
  stopAll(): void {
    for (const jobId of this.timers.keys()) {
      this.cancelTimer(jobId);
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private scheduleNext(jobId: string): void {
    const state = this.jobs.get(jobId);
    if (!state || state.config.enabled === false) return;

    this.cancelTimer(jobId);

    const { schedule } = state.config;
    let delayMs: number;

    switch (schedule.kind) {
      case 'interval':
        delayMs = schedule.everyMs;
        break;
      case 'at': {
        const target = new Date(schedule.at).getTime();
        const now = Date.now();
        delayMs = Math.max(0, target - now);
        break;
      }
      case 'cron':
        // Simplified cron — calculate next run from expression
        delayMs = this.parseCronDelay(schedule.expr, schedule.tz);
        break;
      default:
        return;
    }

    const timer = setTimeout(() => {
      this.runNow(jobId);
    }, delayMs);

    this.timers.set(jobId, timer);
    state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  }

  private cancelTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
      this.timers.delete(jobId);
    }
  }

  private parseCronDelay(expr: string, tz?: string): number {
    // Simplified cron parser — handles basic intervals
    // Full cron parsing will use a library (node-cron) in production
    const parts = expr.trim().split(/\s+/);

    // Handle simple intervals: "*/5 * * * *"
    if (parts[0]?.startsWith('*/')) {
      const minutes = parseInt(parts[0].slice(2), 10);
      return minutes * 60 * 1000;
    }

    // Default: check every minute (will be replaced with proper cron lib)
    return 60 * 1000;
  }
}
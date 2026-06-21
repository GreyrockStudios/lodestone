/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — Scheduler
 *
 * Cron-style recurring task scheduling.
 * Persists tasks to disk and maintains in-memory timers.
 * Supports human-readable intervals: "30m", "1h", "daily at 9am", "weekly on Monday".
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

interface ScheduledTask {
  id: string;
  name: string;
  interval: string;
  prompt: string;
  intervalMs: number;
  nextRun: number;
  createdAt: number;
}

interface SchedulerData {
  tasks: ScheduledTask[];
}

export class SchedulerTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'scheduler',
    name: 'Scheduler',
    description: 'Schedule recurring tasks with human-readable intervals. Supports add, remove, list, and run actions.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: add, remove, list, run', required: true, enum: ['add', 'remove', 'list', 'run'] },
      { name: 'name', type: 'string', description: 'Task name (for add)', required: false },
      { name: 'interval', type: 'string', description: 'Human-readable interval: "30m", "1h", "daily at 9am", "weekly on Monday"', required: false },
      { name: 'prompt', type: 'string', description: 'What to run (the prompt or command)', required: false },
      { name: 'taskId', type: 'string', description: 'Task ID (for remove or run)', required: false },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 10000,
  };

  private static timers: Map<string, NodeJS.Timeout> = new Map();
  private static dataPath: string | null = null;

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    // Initialize data path
    if (!SchedulerTool.dataPath) {
      SchedulerTool.dataPath = join(context.workspaceRoot, 'data', 'scheduler.json');
    }

    try {
      switch (action) {
        case 'add':
          return await this.addTask(params, context, start);
        case 'remove':
          return await this.removeTask(params, context, start);
        case 'list':
          return await this.listTasks(context, start);
        case 'run':
          return await this.runTask(params, context, start);
        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Scheduler action "${action}" failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
  }

  private async addTask(params: Record<string, unknown>, context: ToolContext, start: number): Promise<ToolResult> {
    const name = params.name as string;
    const interval = params.interval as string;
    const prompt = params.prompt as string;

    if (!name) return this.missingParam('name', start);
    if (!interval) return this.missingParam('interval', start);
    if (!prompt) return this.missingParam('prompt', start);

    const intervalMs = this.parseInterval(interval);
    if (intervalMs <= 0) {
      return {
        success: false, data: null,
        summary: `Invalid interval: ${interval}`,
        error: `Could not parse interval "${interval}". Use formats like "30m", "1h", "daily at 9am", "weekly on Monday"`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const data = this.loadData(context);
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: ScheduledTask = {
      id, name, interval, prompt,
      intervalMs,
      nextRun: Date.now() + intervalMs,
      createdAt: Date.now(),
    };

    data.tasks.push(task);
    this.saveData(context, data);

    // Set up in-memory timer
    const timer = setInterval(() => {
      // Timer fires — in a real system this would invoke the engine
      // Here we just update nextRun on disk
      const current = this.loadData(context);
      const t = current.tasks.find(x => x.id === id);
      if (t) {
        t.nextRun = Date.now() + t.intervalMs;
        this.saveData(context, current);
      }
    }, intervalMs);
    SchedulerTool.timers.set(id, timer);

    return {
      success: true,
      data: { id, name, interval, nextRun: task.nextRun },
      summary: `Scheduled task "${name}" every ${interval} (id: ${id})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async removeTask(params: Record<string, unknown>, context: ToolContext, start: number): Promise<ToolResult> {
    const taskId = params.taskId as string;
    if (!taskId) return this.missingParam('taskId', start);

    const data = this.loadData(context);
    const idx = data.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) {
      return {
        success: false, data: null,
        summary: `Task not found: ${taskId}`,
        error: `No task with id "${taskId}"`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const removed = data.tasks.splice(idx, 1)[0];
    this.saveData(context, data);

    // Clear timer
    const timer = SchedulerTool.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      SchedulerTool.timers.delete(taskId);
    }

    return {
      success: true,
      data: { removed: removed.name },
      summary: `Removed task "${removed.name}" (${taskId})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async listTasks(context: ToolContext, start: number): Promise<ToolResult> {
    const data = this.loadData(context);
    const tasks = data.tasks.map(t => ({
      id: t.id,
      name: t.name,
      interval: t.interval,
      prompt: t.prompt.slice(0, 100),
      nextRun: t.nextRun,
      nextRunIn: Math.max(0, t.nextRun - Date.now()),
    }));

    return {
      success: true,
      data: { tasks, count: tasks.length },
      summary: `${tasks.length} scheduled task(s)`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async runTask(params: Record<string, unknown>, context: ToolContext, start: number): Promise<ToolResult> {
    const taskId = params.taskId as string;
    if (!taskId) return this.missingParam('taskId', start);

    const data = this.loadData(context);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) {
      return {
        success: false, data: null,
        summary: `Task not found: ${taskId}`,
        error: `No task with id "${taskId}"`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // Update nextRun
    task.nextRun = Date.now() + task.intervalMs;
    this.saveData(context, data);

    return {
      success: true,
      data: { id: task.id, name: task.name, prompt: task.prompt, triggered: true },
      summary: `Manually triggered task "${task.name}"`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private parseInterval(interval: string): number {
    const lower = interval.toLowerCase().trim();

    // "30m" or "30min" or "30 minutes"
    const minMatch = lower.match(/^(\d+)\s*m(?:in)?(?:utes?)?$/);
    if (minMatch) return parseInt(minMatch[1], 10) * 60 * 1000;

    // "1h" or "1hr" or "2 hours"
    const hourMatch = lower.match(/^(\d+)\s*h(?:r)?(?:ours?)?$/);
    if (hourMatch) return parseInt(hourMatch[1], 10) * 60 * 60 * 1000;

    // "daily at 9am" or "daily at 14:30"
    const dailyMatch = lower.match(/^daily\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (dailyMatch) {
      let hours = parseInt(dailyMatch[1], 10);
      const minutes = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
      const ampm = dailyMatch[3];
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      const now = new Date();
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime() - now.getTime();
    }

    // "weekly on Monday" / "weekly on mon"
    const weeklyMatch = lower.match(/^weekly\s+on\s+(\w+)$/);
    if (weeklyMatch) {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.findIndex(d => d.startsWith(weeklyMatch[1].toLowerCase().slice(0, 3)));
      if (targetDay === -1) return -1;

      const now = new Date();
      const next = new Date();
      next.setHours(9, 0, 0, 0); // Default to 9am
      let dayDiff = (targetDay - now.getDay() + 7) % 7;
      if (dayDiff === 0 && now.getHours() >= 9) dayDiff = 7;
      next.setDate(next.getDate() + dayDiff);
      return next.getTime() - now.getTime();
    }

    // "45s" or "30 seconds"
    const secMatch = lower.match(/^(\d+)\s*s(?:ec)?(?:onds?)?$/);
    if (secMatch) return parseInt(secMatch[1], 10) * 1000;

    return -1; // Unparseable
  }

  private loadData(context: ToolContext): SchedulerData {
    const path = SchedulerTool.dataPath || join(context.workspaceRoot, 'data', 'scheduler.json');
    if (!existsSync(path)) {
      return { tasks: [] };
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as SchedulerData;
    } catch (err) {
      context.log.warn('Failed to load scheduler data, returning empty', { error: err instanceof Error ? err.message : String(err), path });
      return { tasks: [] };
    }
  }

  private saveData(context: ToolContext, data: SchedulerData): void {
    const path = SchedulerTool.dataPath || join(context.workspaceRoot, 'data', 'scheduler.json');
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  }

  private missingParam(name: string, start: number): ToolResult {
    return {
      success: false, data: null,
      summary: `Missing required parameter: ${name}`,
      error: `Missing parameter: ${name}`,
      durationMs: Date.now() - start, includeInContext: false,
    };
  }
}
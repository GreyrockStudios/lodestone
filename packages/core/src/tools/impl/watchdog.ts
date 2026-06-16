/**
 * Lodestone — Watchdog Tool
 *
 * Registers expected outcomes with deadlines. If the expected outcome
 * doesn't happen by the deadline, it's flagged as missed.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface WatchEntry {
  id: string;
  description: string;
  expectedOutcome: string;
  expectedBy: string; // ISO timestamp
  severity: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  status: 'pending' | 'met' | 'missed' | 'cancelled';
  actualOutcome?: string;
  resolvedAt?: string;
}

const definition: ToolDefinition = {
  id: 'watchdog',
  name: 'Watchdog',
  description: 'Register expected outcomes with deadlines. Flag missed deadlines.',
  parameters: [
    { name: 'action', description: 'watch, check, resolve, list', type: 'string', required: true },
    { name: 'description', description: 'What should happen', type: 'string', required: false },
    { name: 'expectedOutcome', description: 'How to verify it happened', type: 'string', required: false },
    { name: 'expectedBy', description: 'ISO timestamp — when this should happen by', type: 'string', required: false },
    { name: 'severity', description: 'low, medium, high, critical', type: 'string', required: false },
    { name: 'id', description: 'Watch ID for resolve', type: 'string', required: false },
    { name: 'actualOutcome', description: 'What actually happened', type: 'string', required: false },
    { name: 'status', description: 'met or cancelled', type: 'string', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class WatchdogTool implements Tool {
  readonly definition = definition;
  private watches: Map<string, WatchEntry> = new Map();

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    switch (action) {
      case 'watch':
        return this.watch(params);
      case 'check':
        return this.check();
      case 'resolve':
        return this.resolve(params);
      case 'list':
        return this.list(params);
      default:
        return {
          success: false, data: null,
          summary: `Unknown action: ${action}`,
          error: 'Valid actions: watch, check, resolve, list',
          durationMs: Date.now() - start,
          includeInContext: true,
        };
    }
  }

  private watch(params: Record<string, unknown>): ToolResult {
    const id = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const entry: WatchEntry = {
      id,
      description: params.description as string,
      expectedOutcome: params.expectedOutcome as string,
      expectedBy: params.expectedBy as string,
      severity: (params.severity as WatchEntry['severity']) || 'medium',
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    this.watches.set(id, entry);

    return {
      success: true,
      data: entry,
      summary: `Watch registered: ${entry.description} (by ${entry.expectedBy})`,
      durationMs: 0,
      includeInContext: true,
    };
  }

  private check(): ToolResult {
    const now = new Date();
    const missed: WatchEntry[] = [];
    const pending: WatchEntry[] = [];

    for (const entry of this.watches.values()) {
      if (entry.status !== 'pending') continue;
      const deadline = new Date(entry.expectedBy);
      if (deadline < now) {
        entry.status = 'missed';
        missed.push(entry);
      } else {
        pending.push(entry);
      }
    }

    return {
      success: true,
      data: { missed, pending, total: this.watches.size },
      summary: missed.length > 0
        ? `⚠️ ${missed.length} missed watches, ${pending.length} pending`
        : `✅ All ${pending.length} watches on track`,
      durationMs: 0,
      includeInContext: true,
    };
  }

  private resolve(params: Record<string, unknown>): ToolResult {
    const id = params.id as string;
    const entry = this.watches.get(id);

    if (!entry) {
      return {
        success: false, data: null,
        summary: `Watch ${id} not found`,
        error: 'Not found',
        durationMs: 0,
        includeInContext: true,
      };
    }

    entry.status = (params.status as 'met' | 'cancelled') || 'met';
    entry.actualOutcome = params.actualOutcome as string;
    entry.resolvedAt = new Date().toISOString();

    return {
      success: true,
      data: entry,
      summary: `Watch ${id} resolved as ${entry.status}: ${entry.actualOutcome}`,
      durationMs: 0,
      includeInContext: true,
    };
  }

  private list(params: Record<string, unknown>): ToolResult {
    const status = params.status as string | undefined;
    let entries = Array.from(this.watches.values());

    if (status) {
      entries = entries.filter(e => e.status === status);
    }

    return {
      success: true,
      data: entries,
      summary: `${entries.length} watches`,
      durationMs: 0,
      includeInContext: true,
    };
  }
}
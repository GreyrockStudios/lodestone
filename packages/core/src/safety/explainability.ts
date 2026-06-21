/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Explainability Layer
 *
 * Every response includes a traceable chain showing:
 * - Intent detected
 * - Safety checks run
 * - Rules applied
 * - Memory recalled
 * - Tool calls made
 * - Confidence level
 *
 * Traces are stored in memory (cap 50 recent) and exposed via
 * the dashboard API for audit and debugging.
 */

import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExplainStep {
  /** Phase name: 'intent', 'safety-check', 'tool-call', 'memory-recall', 'response', etc. */
  phase: string;
  /** Human-readable description of what happened */
  description: string;
  /** Result of this step */
  result: string;
  /** Duration of this step in ms */
  durationMs: number;
}

export interface ExplainTrace {
  /** Unique trace ID */
  id: string;
  /** Session ID this trace belongs to */
  sessionId: string;
  /** Timestamp when the trace started */
  timestamp: number;
  /** The user's message that triggered this trace */
  userMessage: string;
  /** The agent's response */
  response: string;
  /** Steps in the execution chain */
  steps: ExplainStep[];
  /** Confidence score (if available) */
  confidence?: number;
  /** Total duration of the turn in ms */
  durationMs: number;
}

// ─── Explainability Layer ─────────────────────────────────────────────────────

export class ExplainabilityLayer {
  private traces: Map<string, ExplainTrace> = new Map();
  private order: string[] = []; // Track insertion order for eviction
  private maxTraces: number;
  private log = getLogger('explainability');

  constructor(maxTraces = 50) {
    this.maxTraces = maxTraces;
  }

  /**
   * Begin a new trace for a user message.
   * Returns the trace ID.
   */
  beginTrace(sessionId: string, userMessage: string): string {
    const id = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const trace: ExplainTrace = {
      id,
      sessionId,
      timestamp: Date.now(),
      userMessage,
      response: '',
      steps: [],
      durationMs: 0,
    };

    this.traces.set(id, trace);
    this.order.push(id);

    // Enforce trace limit (FIFO eviction)
    while (this.order.length > this.maxTraces) {
      const oldestId = this.order.shift()!;
      this.traces.delete(oldestId);
    }

    this.log.debug('Trace started', { id, sessionId });
    return id;
  }

  /**
   * Add a step to an existing trace.
   */
  addStep(traceId: string, step: ExplainStep): void {
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.log.warn('Step added to unknown trace', { traceId, phase: step.phase });
      return;
    }

    trace.steps.push(step);
    this.log.debug('Trace step added', { traceId, phase: step.phase, durationMs: step.durationMs });
  }

  /**
   * Finalize a trace with the response and optional confidence.
   * Returns the complete trace.
   */
  endTrace(traceId: string, response: string, confidence?: number): ExplainTrace | null {
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.log.warn('End trace called for unknown trace', { traceId });
      return null;
    }

    trace.response = response;
    trace.confidence = confidence;
    trace.durationMs = Date.now() - trace.timestamp;

    this.log.debug('Trace finalized', {
      traceId,
      steps: trace.steps.length,
      durationMs: trace.durationMs,
      confidence,
    });

    return trace;
  }

  /**
   * Get a trace by ID.
   */
  getTrace(traceId: string): ExplainTrace | null {
    return this.traces.get(traceId) || null;
  }

  /**
   * Get recent traces (newest first).
   */
  getRecentTraces(limit = 10): ExplainTrace[] {
    const ids = [...this.order].reverse();
    return ids
      .slice(0, limit)
      .map(id => this.traces.get(id))
      .filter((t): t is ExplainTrace => t !== undefined);
  }

  /**
   * Get traces for a specific session.
   */
  getTracesBySession(sessionId: string, limit = 10): ExplainTrace[] {
    return Array.from(this.traces.values())
      .filter(t => t.sessionId === sessionId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Format a trace as a human-readable string for dashboard/audit.
   */
  formatTrace(traceId: string): string {
    const trace = this.traces.get(traceId);
    if (!trace) return `Trace ${traceId} not found`;

    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(`  Trace: ${trace.id}`);
    lines.push(`  Session: ${trace.sessionId}`);
    lines.push(`  Time: ${new Date(trace.timestamp).toISOString()}`);
    lines.push(`  Duration: ${trace.durationMs}ms`);
    lines.push(`  Confidence: ${trace.confidence !== undefined ? trace.confidence + '%' : 'N/A'}`);
    lines.push('───────────────────────────────────────────────────────────');
    lines.push(`  User: ${trace.userMessage.slice(0, 200)}`);
    lines.push('───────────────────────────────────────────────────────────');
    lines.push('  Execution Chain:');

    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i];
      lines.push(`    ${i + 1}. [${step.phase}] (${step.durationMs}ms)`);
      lines.push(`       ${step.description}`);
      lines.push(`       → ${step.result}`);
    }

    lines.push('───────────────────────────────────────────────────────────');
    lines.push(`  Response: ${trace.response.slice(0, 500)}${trace.response.length > 500 ? '...' : ''}`);
    lines.push('═══════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Format a trace as a structured object for the dashboard API.
   */
  formatForDashboard(trace: ExplainTrace): object {
    return {
      id: trace.id,
      sessionId: trace.sessionId,
      timestamp: new Date(trace.timestamp).toISOString(),
      durationMs: trace.durationMs,
      confidence: trace.confidence,
      userMessage: trace.userMessage,
      response: trace.response,
      steps: trace.steps.map((s, i) => ({
        index: i + 1,
        phase: s.phase,
        description: s.description,
        result: s.result,
        durationMs: s.durationMs,
      })),
      stepCount: trace.steps.length,
    };
  }

  /**
   * Get statistics for dashboard.
   */
  getStats(): {
    totalTraces: number;
    avgDurationMs: number;
    avgSteps: number;
    avgConfidence: number | null;
    byPhase: Record<string, number>;
  } {
    const traces = Array.from(this.traces.values());
    if (traces.length === 0) {
      return { totalTraces: 0, avgDurationMs: 0, avgSteps: 0, avgConfidence: null, byPhase: {} };
    }

    const totalDuration = traces.reduce((sum, t) => sum + t.durationMs, 0);
    const totalSteps = traces.reduce((sum, t) => sum + t.steps.length, 0);
    const confidences = traces.filter(t => t.confidence !== undefined).map(t => t.confidence!);
    const byPhase: Record<string, number> = {};

    for (const trace of traces) {
      for (const step of trace.steps) {
        byPhase[step.phase] = (byPhase[step.phase] || 0) + 1;
      }
    }

    return {
      totalTraces: traces.length,
      avgDurationMs: Math.round(totalDuration / traces.length),
      avgSteps: Math.round(totalSteps / traces.length),
      avgConfidence: confidences.length > 0 ? Math.round(confidences.reduce((s, c) => s + c, 0) / confidences.length) : null,
      byPhase,
    };
  }

  /**
   * Clear all traces.
   */
  clear(): void {
    this.traces.clear();
    this.order = [];
    this.log.info('All traces cleared');
  }
}
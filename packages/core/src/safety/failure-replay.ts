/**
 * Lodestone — Failure Replay
 *
 * When something goes wrong, replay the exact decision sequence that led
 * to failure. Like a flight data recorder.
 *
 * Process:
 * 1. During agent loop execution, record each step as a DecisionTrace
 * 2. After each turn, check for failure signals (error responses, tool failures, safety violations, user corrections)
 * 3. On failure, replay the decision chain and annotate where it went wrong
 * 4. Generate a prevention rule to avoid repeating the mistake
 *
 * No LLM required — all analysis is deterministic.
 */

import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import type { Logger } from '../utils/logger.js';
import type { BehavioralRule } from './behavioral-learning.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DecisionTrace {
  /** Unique trace ID */
  id: string;
  /** When this trace was recorded */
  timestamp: number;
  /** Session this trace belongs to */
  sessionId: string;
  /** The steps in the decision chain */
  steps: DecisionStep[];
  /** Overall outcome */
  outcome: 'success' | 'failure' | 'partial';
  /** What went wrong (if failure) */
  failureReason?: string;
  /** The final response text (for context) */
  finalResponse?: string;
}

export interface DecisionStep {
  /** Which phase of the agent loop */
  phase: 'intent' | 'safety_check' | 'tool_call' | 'memory_recall' | 'response_generation';
  /** What action was taken */
  action: string;
  /** Input to this step */
  input: string;
  /** Output from this step */
  output: string;
  /** How long this step took */
  durationMs: number;
  /** Warning or error flag */
  flag?: 'warning' | 'error';
}

export interface FailureSignal {
  /** Type of failure signal */
  type: 'error-response' | 'tool-failure' | 'safety-violation' | 'user-correction' | 'timeout' | 'empty-response';
  /** Which step triggered the signal */
  stepIndex: number;
  /** Description of the signal */
  description: string;
  /** Severity (0-1) */
  severity: number;
}

export interface FailureAnalysis {
  /** The trace that was analyzed */
  traceId: string;
  /** When the failure occurred */
  timestamp: number;
  /** Session ID */
  sessionId: string;
  /** The full decision chain */
  steps: AnnotatedStep[];
  /** What went wrong */
  failureReason: string;
  /** Where in the chain it went wrong */
  failurePoint: number;
  /** Signals detected */
  signals: FailureSignal[];
  /** What should have happened instead */
  expectedBehavior: string;
  /** Prevention rule proposal */
  preventionRule: PreventionRule;
}

export interface AnnotatedStep extends DecisionStep {
  /** Whether this step contributed to the failure */
  contributedToFailure: boolean;
  /** Annotation explaining the step's role */
  annotation: string;
}

export interface PreventionRule {
  /** What trigger should activate this rule */
  trigger: string;
  /** What to do instead */
  correctBehavior: string;
  /** What to avoid */
  incorrectBehavior: string;
  /** How confident we are this prevention will help (0-1) */
  confidence: number;
  /** The failure this rule prevents */
  sourceFailure: string;
}

export interface FailureReplayConfig {
  /** Data directory for storing traces and reports */
  dataDir: string;
  /** Logger */
  logger: Logger;
  /** Maximum traces to keep in memory (default 100) */
  maxTraces?: number;
  /** Maximum failure reports to archive (default 50) */
  maxArchivedFailures?: number;
  /** Existing behavioral rules (for generating prevention rules) */
  existingRules?: BehavioralRule[];
}

// ─── Failure Replay System ──────────────────────────────────────────────────

export class FailureReplay {
  private config: Required<FailureReplayConfig>;
  private recentTraces: Map<string, DecisionTrace> = new Map();
  private archivedFailures: FailureAnalysis[] = [];
  private traceOrder: string[] = []; // For LRU eviction
  private archivePath: string;

  constructor(config: FailureReplayConfig) {
    this.config = {
      dataDir: config.dataDir,
      logger: config.logger,
      maxTraces: config.maxTraces ?? 100,
      maxArchivedFailures: config.maxArchivedFailures ?? 50,
      existingRules: config.existingRules ?? [],
    };

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
    } catch { /* exists */ }

    this.archivePath = join(this.config.dataDir, 'failure-archive.json');
  }

  /** Initialize by loading archived failures */
  async init(): Promise<void> {
    if (existsSync(this.archivePath)) {
      try {
        this.archivedFailures = JSON.parse(readFileSync(this.archivePath, 'utf-8'));
        this.config.logger.info(`[failure-replay] Loaded ${this.archivedFailures.length} archived failures`);
      } catch {
        this.archivedFailures = [];
      }
    }
  }

  /**
   * Record a decision trace from the agent loop.
   * Called after each turn completes.
   */
  recordDecisionTrace(trace: DecisionTrace): void {
    // Store the trace
    this.recentTraces.set(trace.id, trace);
    this.traceOrder.push(trace.id);

    // Enforce the trace cap
    while (this.traceOrder.length > this.config.maxTraces) {
      const oldestId = this.traceOrder.shift()!;
      this.recentTraces.delete(oldestId);
    }

    // Check for failures
    const signals = this.detectFailures(trace);

    if (signals.length > 0 && trace.outcome !== 'success') {
      this.config.logger.warn(`[failure-replay] Failure detected in trace ${trace.id}`, {
        signals: signals.length,
        outcome: trace.outcome,
        failureReason: trace.failureReason,
      });

      // Analyze and archive the failure
      const analysis = this.replayFailure(trace.id);
      if (analysis) {
        this.archiveFailure(analysis);
      }
    }
  }

  /**
   * Detect failure signals in a trace.
   * Checks for error responses, tool failures, safety violations, user corrections.
   */
  detectFailures(trace: DecisionTrace): FailureSignal[] {
    const signals: FailureSignal[] = [];

    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i];

      // Error flag from the step itself
      if (step.flag === 'error') {
        signals.push({
          type: 'tool-failure',
          stepIndex: i,
          description: `Step ${i} (${step.phase}) flagged as error: ${step.output.slice(0, 200)}`,
          severity: 0.8,
        });
      }

      // Warning flag
      if (step.flag === 'warning') {
        signals.push({
          type: 'safety-violation',
          stepIndex: i,
          description: `Step ${i} (${step.phase}) flagged as warning: ${step.output.slice(0, 200)}`,
          severity: 0.5,
        });
      }

      // Tool call failure (output contains error indicators)
      if (step.phase === 'tool_call') {
        const outputLower = step.output.toLowerCase();
        if (outputLower.includes('error') || outputLower.includes('failed') || outputLower.includes('exception')) {
          signals.push({
            type: 'tool-failure',
            stepIndex: i,
            description: `Tool call failed: ${step.output.slice(0, 200)}`,
            severity: 0.7,
          });
        }
        if (outputLower.includes('timeout') || outputLower.includes('timed out')) {
          signals.push({
            type: 'timeout',
            stepIndex: i,
            description: `Tool call timed out: ${step.output.slice(0, 200)}`,
            severity: 0.6,
          });
        }
      }

      // Empty response generation
      if (step.phase === 'response_generation' && step.output.trim().length === 0) {
        signals.push({
          type: 'empty-response',
          stepIndex: i,
          description: 'Response generation produced empty output',
          severity: 0.9,
        });
      }

      // Safety check failure (output indicates rejection or block)
      if (step.phase === 'safety_check') {
        const outputLower = step.output.toLowerCase();
        if (outputLower.includes('blocked') || outputLower.includes('rejected') || outputLower.includes('denied')) {
          signals.push({
            type: 'safety-violation',
            stepIndex: i,
            description: `Safety check blocked action: ${step.output.slice(0, 200)}`,
            severity: 0.7,
          });
        }
      }

      // Error in the final response
      if (step.phase === 'response_generation' && trace.outcome === 'failure') {
        const outputLower = step.output.toLowerCase();
        const errorIndicators = ['sorry, i can\'t', 'i encountered an error', 'something went wrong', 'i failed to', 'unable to complete'];
        for (const indicator of errorIndicators) {
          if (outputLower.includes(indicator)) {
            signals.push({
              type: 'error-response',
              stepIndex: i,
              description: `Error response detected: "${indicator}" found in output`,
              severity: 0.8,
            });
            break;
          }
        }
      }
    }

    // Check for user correction in the trace's failure reason
    if (trace.failureReason && trace.failureReason.toLowerCase().includes('user correction')) {
      // Find the response generation step
      const responseStepIdx = trace.steps.findIndex(s => s.phase === 'response_generation');
      if (responseStepIdx >= 0) {
        signals.push({
          type: 'user-correction',
          stepIndex: responseStepIdx,
          description: `User corrected the response: ${trace.failureReason.slice(0, 200)}`,
          severity: 0.6,
        });
      }
    }

    return signals;
  }

  /**
   * Replay a failure trace and produce an analysis.
   * Reconstructs the decision chain and annotates where it went wrong.
   */
  replayFailure(traceId: string): FailureAnalysis | null {
    const trace = this.recentTraces.get(traceId);
    if (!trace) {
      this.config.logger.warn(`[failure-replay] Trace ${traceId} not found`);
      return null;
    }

    const signals = this.detectFailures(trace);

    if (signals.length === 0) {
      this.config.logger.debug(`[failure-replay] No failure signals in trace ${traceId}`);
      return null;
    }

    // Annotate each step
    const annotatedSteps: AnnotatedStep[] = trace.steps.map((step, index) => {
      const matchingSignals = signals.filter(s => s.stepIndex === index);
      const contributedToFailure = matchingSignals.length > 0;

      let annotation: string;
      if (contributedToFailure) {
        annotation = matchingSignals.map(s => s.description).join('; ');
      } else if (index === trace.steps.length - 1 && trace.outcome === 'failure') {
        // Last step in a failed trace without explicit signals
        annotation = 'Final step in failed trace — outcome was failure';
      } else {
        annotation = 'No issues detected in this step';
      }

      return {
        ...step,
        contributedToFailure,
        annotation,
      };
    });

    // Find the primary failure point (highest severity signal)
    const primarySignal = signals.reduce((highest, current) =>
      current.severity > highest.severity ? current : highest
    );

    const failurePoint = primarySignal.stepIndex;

    // Determine failure reason
    const failureReason = trace.failureReason
      || primarySignal.description
      || `Failure detected at step ${failurePoint} (${trace.steps[failurePoint]?.phase || 'unknown'})`;

    // Determine expected behavior
    const expectedBehavior = this.determineExpectedBehavior(trace, primarySignal);

    // Generate prevention rule
    const preventionRule = this.proposePrevention({
      traceId: trace.id,
      timestamp: trace.timestamp,
      sessionId: trace.sessionId,
      steps: annotatedSteps,
      failureReason,
      failurePoint,
      signals,
      expectedBehavior,
      preventionRule: {} as PreventionRule, // placeholder, filled below
    });

    return {
      traceId: trace.id,
      timestamp: trace.timestamp,
      sessionId: trace.sessionId,
      steps: annotatedSteps,
      failureReason,
      failurePoint,
      signals,
      expectedBehavior,
      preventionRule,
    };
  }

  /**
   * Generate a prevention rule from a failure analysis.
   */
  proposePrevention(failure: FailureAnalysis): PreventionRule {
    const failingStep = failure.steps[failure.failurePoint];
    const phase = failingStep?.phase || 'unknown';

    // Check if an existing rule already covers this
    const existingRule = this.config.existingRules.find(r =>
      r.correctBehavior.toLowerCase().includes(failingStep?.action.toLowerCase().slice(0, 20) || '')
    );

    if (existingRule) {
      // Reinforce existing rule
      return {
        trigger: existingRule.trigger,
        correctBehavior: existingRule.correctBehavior,
        incorrectBehavior: failingStep?.output.slice(0, 200) || 'unknown behavior',
        confidence: Math.min(1, existingRule.confidence + 0.1),
        sourceFailure: failure.traceId,
      };
    }

    // Generate a new prevention rule based on the failure type
    const primarySignalType = failure.signals[0]?.type || 'error-response';

    let trigger: string;
    let correctBehavior: string;
    let incorrectBehavior: string;
    let confidence: number;

    switch (primarySignalType) {
      case 'tool-failure':
        trigger = `When calling tools in phase ${phase}`;
        correctBehavior = `Verify tool inputs are valid before calling — ${failingStep?.action} failed with: ${failingStep?.output.slice(0, 100)}`;
        incorrectBehavior = `Calling ${failingStep?.action} without validating inputs`;
        confidence = 0.7;
        break;

      case 'timeout':
        trigger = `When executing long-running operations in phase ${phase}`;
        correctBehavior = 'Set appropriate timeouts and handle timeout gracefully with a fallback response';
        incorrectBehavior = 'Allowing operations to run indefinitely without timeout handling';
        confidence = 0.65;
        break;

      case 'safety-violation':
        trigger = `When safety check fails in phase ${phase}`;
        correctBehavior = `Address the safety concern before proceeding — ${failingStep?.output.slice(0, 100)}`;
        incorrectBehavior = `Proceeding despite safety block: ${failingStep?.output.slice(0, 100)}`;
        confidence = 0.85;
        break;

      case 'user-correction':
        trigger = `When generating responses in similar context`;
        correctBehavior = `Generate a response that addresses the user's actual intent — ${failure.expectedBehavior}`;
        incorrectBehavior = failingStep?.output.slice(0, 200) || 'the original response that was corrected';
        confidence = 0.6;
        break;

      case 'empty-response':
        trigger = `When response generation yields empty output`;
        correctBehavior = 'Check for LLM errors and provide a fallback response explaining the issue';
        incorrectBehavior = 'Returning an empty response to the user';
        confidence = 0.9;
        break;

      case 'error-response':
      default:
        trigger = `When ${phase} produces an error`;
        correctBehavior = `Handle errors gracefully and provide a helpful response — expected: ${failure.expectedBehavior}`;
        incorrectBehavior = `Returning error message to user without context or recovery attempt`;
        confidence = 0.7;
        break;
    }

    return {
      trigger,
      correctBehavior,
      incorrectBehavior,
      confidence,
      sourceFailure: failure.traceId,
    };
  }

  /**
   * Get recent failure analyses.
   */
  getRecentFailures(limit: number = 10): FailureAnalysis[] {
    return this.archivedFailures.slice(-limit).reverse();
  }

  /**
   * Get a specific trace by ID.
   */
  getTrace(traceId: string): DecisionTrace | undefined {
    return this.recentTraces.get(traceId);
  }

  /**
   * Get all recent traces.
   */
  getRecentTraces(limit: number = 20): DecisionTrace[] {
    const ids = this.traceOrder.slice(-limit);
    return ids.map(id => this.recentTraces.get(id)).filter((t): t is DecisionTrace => t !== undefined);
  }

  /**
   * Update existing rules (called when behavioral learning updates its rules).
   */
  updateExistingRules(rules: BehavioralRule[]): void {
    this.config.existingRules = rules;
  }

  /**
   * Get failure statistics.
   */
  getStats(): {
    totalTraces: number;
    totalFailures: number;
    failureRate: number;
    failuresByType: Record<string, number>;
    avgSeverity: number;
  } {
    const totalTraces = this.recentTraces.size;
    const failures = this.archivedFailures;

    const failuresByType: Record<string, number> = {};
    let totalSeverity = 0;

    for (const f of failures) {
      for (const s of f.signals) {
        failuresByType[s.type] = (failuresByType[s.type] || 0) + 1;
        totalSeverity += s.severity;
      }
    }

    return {
      totalTraces,
      totalFailures: failures.length,
      failureRate: totalTraces > 0 ? failures.length / totalTraces : 0,
      failuresByType,
      avgSeverity: failures.length > 0 ? totalSeverity / failures.flatMap(f => f.signals).length : 0,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private determineExpectedBehavior(trace: DecisionTrace, primarySignal: FailureSignal): string {
    const failingStep = trace.steps[primarySignal.stepIndex];

    if (!failingStep) {
      return 'Unknown — no failing step found';
    }

    switch (primarySignal.type) {
      case 'tool-failure':
        return `Tool ${failingStep.action} should have completed successfully with valid inputs`;
      case 'timeout':
        return `Operation should have completed within the expected time or handled the timeout gracefully`;
      case 'safety-violation':
        return `Safety check should have passed, or the agent should have adjusted its approach to comply with safety rules`;
      case 'user-correction':
        return `Response should have addressed the user's actual intent without needing correction`;
      case 'empty-response':
        return `Response generation should have produced meaningful output`;
      case 'error-response':
        return `Response should have completed the task without encountering an error`;
      default:
        return `Step ${primarySignal.stepIndex} should have completed successfully`;
    }
  }

  private archiveFailure(analysis: FailureAnalysis): void {
    this.archivedFailures.push(analysis);

    // Enforce archive cap
    while (this.archivedFailures.length > this.config.maxArchivedFailures) {
      this.archivedFailures.shift();
    }

    // Persist to disk
    try {
      writeFileSync(this.archivePath, JSON.stringify(this.archivedFailures, null, 2));
    } catch (err) {
      this.config.logger.warn(`[failure-replay] Failed to archive failure`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.config.logger.info(`[failure-replay] Failure archived`, {
      traceId: analysis.traceId,
      failurePoint: analysis.failurePoint,
      signals: analysis.signals.length,
    });
  }
}

// ─── Trace Builder Helper ───────────────────────────────────────────────────

/**
 * Helper to build a DecisionTrace during agent loop execution.
 * Collects steps as the loop progresses and produces the final trace.
 */
export class TraceBuilder {
  private steps: DecisionStep[] = [];
  private id: string;
  private sessionId: string;
  private timestamp: number;

  constructor(sessionId: string) {
    this.id = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.sessionId = sessionId;
    this.timestamp = Date.now();
  }

  /** Add a step to the trace */
  addStep(step: Omit<DecisionStep, 'durationMs'>, startTime: number): void {
    this.steps.push({
      ...step,
      durationMs: Date.now() - startTime,
    });
  }

  /** Build the final trace */
  build(outcome: DecisionTrace['outcome'], failureReason?: string, finalResponse?: string): DecisionTrace {
    return {
      id: this.id,
      timestamp: this.timestamp,
      sessionId: this.sessionId,
      steps: this.steps,
      outcome,
      failureReason,
      finalResponse,
    };
  }
}
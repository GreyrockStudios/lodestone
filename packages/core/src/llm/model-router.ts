/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Multi-Model Routing
 *
 * Routes different task types to different models based on intent,
 * complexity, confidence, and budget constraints.
 *
 * - Intent-based: simple questions → cheap model, complex reasoning → expensive model
 * - Confidence-based: if cheap model's confidence is low, escalate to expensive
 * - Task-based: code generation vs summarization vs analysis → different models
 * - Cost-based: if daily budget exceeded, route to cheaper model
 *
 * No external dependencies — uses only built-in modules.
 */

import { getLogger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RoutingContext {
  /** Detected intent (from IntentPredictor, e.g. 'question', 'task', 'social') */
  intent: string;
  /** Estimated complexity of the request */
  complexity: 'low' | 'medium' | 'high';
  /** Session ID for tracking escalation state */
  sessionId: string;
  /** Length of conversation history (more history = more context needed) */
  historyLength: number;
}

export interface RoutingDecision {
  /** Model identifier to use (e.g. 'glm-4.5:cloud', 'glm-5.2:cloud') */
  model: string;
  /** Human-readable reason for this routing decision */
  reason: string;
  /** Whether this is an escalation from a cheaper model */
  escalated: boolean;
}

export interface RoutingRule {
  /** Pattern to match against intent (regex string, e.g. 'greeting|simple|social') */
  pattern: string;
  /** Model to route to when this pattern matches */
  model: string;
  /** Priority (higher = checked first) */
  priority: number;
}

export interface RoutingStats {
  /** Total routing decisions made */
  totalDecisions: number;
  /** Number of escalations performed */
  escalations: number;
  /** Decisions by model */
  byModel: Record<string, number>;
  /** Decisions by reason */
  byReason: Record<string, number>;
  /** Estimated cost savings from using cheaper models */
  estimatedSavings: number;
}

// ─── Default Routing Rules ────────────────────────────────────────────────────

const DEFAULT_ROUTES: RoutingRule[] = [
  { pattern: 'social|greeting|simple', model: '__CHEAP__', priority: 10 },
  { pattern: 'summarization|monitoring|follow-up', model: '__MEDIUM__', priority: 8 },
  { pattern: 'task|code|analysis|correction', model: '__EXPENSIVE__', priority: 9 },
  { pattern: 'ambiguous|proactive', model: '__MEDIUM__', priority: 5 },
];

// ─── Default Model Tiers ──────────────────────────────────────────────────────

const DEFAULT_CHEAP_MODEL = 'glm-4.5:cloud';
const DEFAULT_MEDIUM_MODEL = 'glm-4.5:cloud';
const DEFAULT_EXPENSIVE_MODEL = 'glm-5.2:cloud';

// ─── Model Router ──────────────────────────────────────────────────────────────

export class ModelRouter {
  private log = getLogger('model-router');
  private rules: RoutingRule[];
  private defaultModel: string;
  private escalationModel: string;
  private cheapModel: string;
  private mediumModel: string;
  private expensiveModel: string;

  /** Per-session escalation tracking */
  private escalatedSessions: Set<string> = new Set();
  /** Per-session model override (from manual escalation) */
  private sessionOverrides: Map<string, string> = new Map();

  /** Stats */
  private stats = {
    totalDecisions: 0,
    escalations: 0,
    byModel: {} as Record<string, number>,
    byReason: {} as Record<string, number>,
    estimatedSavings: 0,
  };

  constructor(opts: {
    defaultModel: string;
    escalationModel: string;
    routes?: RoutingRule[];
    /** Cheap model for simple tasks (defaults to a sensible value) */
    cheapModel?: string;
    /** Medium model for medium tasks */
    mediumModel?: string;
    /** Expensive model for complex tasks */
    expensiveModel?: string;
  }) {
    this.defaultModel = opts.defaultModel || DEFAULT_EXPENSIVE_MODEL;
    this.escalationModel = opts.escalationModel || DEFAULT_EXPENSIVE_MODEL;
    this.cheapModel = opts.cheapModel || DEFAULT_CHEAP_MODEL;
    this.mediumModel = opts.mediumModel || DEFAULT_MEDIUM_MODEL;
    this.expensiveModel = opts.expensiveModel || DEFAULT_EXPENSIVE_MODEL;

    // Process provided routes, resolving model tier placeholders
    this.rules = (opts.routes || DEFAULT_ROUTES).map(r => ({
      ...r,
      model: this.resolveModelAlias(r.model),
    }));
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  /**
   * Determine which model to use for a given request context.
   * Evaluates routing rules in priority order, then applies cost/escalation logic.
   */
  routeRequest(context: RoutingContext): RoutingDecision {
    this.stats.totalDecisions++;

    // Check for manual override first
    const override = this.sessionOverrides.get(context.sessionId);
    if (override) {
      this.recordDecision(override, 'manual-override');
      return {
        model: override,
        reason: 'Manual override set for this session',
        escalated: true,
      };
    }

    // Check if session was already escalated
    const alreadyEscalated = this.escalatedSessions.has(context.sessionId);

    // Evaluate routing rules in priority order (highest priority first)
    const sortedRules = [...this.rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      const regex = new RegExp(rule.pattern, 'i');
      if (regex.test(context.intent)) {
        // If already escalated and rule points to a cheaper model, skip
        if (alreadyEscalated && this.isCheaperThan(rule.model, this.escalationModel)) {
          this.recordDecision(this.escalationModel, `already-escalated-session, rule:${rule.pattern}`);
          return {
            model: this.escalationModel,
            reason: `Session previously escalated — using ${this.escalationModel}`,
            escalated: true,
          };
        }

        this.recordDecision(rule.model, `rule-match:${rule.pattern}`);
        return {
          model: rule.model,
          reason: `Routed by rule pattern '${rule.pattern}' (intent: ${context.intent})`,
          escalated: false,
        };
      }
    }

    // Complexity-based fallback
    let model = this.defaultModel;
    let reason = `Default model (no rule matched, complexity: ${context.complexity})`;

    if (context.complexity === 'high') {
      model = this.expensiveModel;
      reason = `High complexity → expensive model (${this.expensiveModel})`;
    } else if (context.complexity === 'low') {
      model = this.cheapModel;
      reason = `Low complexity → cheap model (${this.cheapModel})`;
    } else if (context.complexity === 'medium') {
      model = this.mediumModel;
      reason = `Medium complexity → medium model (${this.mediumModel})`;
    }

    // If already escalated, use escalation model
    if (alreadyEscalated) {
      model = this.escalationModel;
      reason = `Session previously escalated → ${this.escalationModel}`;
    }

    this.recordDecision(model, reason);
    return {
      model,
      reason,
      escalated: alreadyEscalated,
    };
  }

  // ─── Escalation ────────────────────────────────────────────────────────────

  /**
   * Escalate a session to a better model.
   * Called when confidence is low on the current model's response.
   */
  escalate(sessionId: string, reason: string): void {
    this.escalatedSessions.add(sessionId);
    this.stats.escalations++;
    this.log.info('Session escalated', { sessionId, reason, newModel: this.escalationModel });
  }

  /**
   * Manually set a model override for a session.
   * Takes precedence over all routing rules.
   */
  setSessionModel(sessionId: string, model: string): void {
    this.sessionOverrides.set(sessionId, model);
    this.log.info('Session model override set', { sessionId, model });
  }

  /** Clear escalation state for a session */
  clearEscalation(sessionId: string): void {
    this.escalatedSessions.delete(sessionId);
    this.sessionOverrides.delete(sessionId);
  }

  // ─── Rule Management ────────────────────────────────────────────────────────

  /** Register a new routing rule */
  registerRoute(rule: RoutingRule): void {
    const resolved = { ...rule, model: this.resolveModelAlias(rule.model) };
    this.rules.push(resolved);
    // Re-sort by priority
    this.rules.sort((a, b) => b.priority - a.priority);
    this.log.info('Routing rule registered', { pattern: rule.pattern, model: resolved.model, priority: rule.priority });
  }

  /** Get all registered routing rules */
  getRoutes(): RoutingRule[] {
    return [...this.rules];
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  /** Get routing statistics */
  getStats(): RoutingStats {
    return { ...this.stats, byModel: { ...this.stats.byModel }, byReason: { ...this.stats.byReason } };
  }

  /** Reset stats (e.g. at the start of a new day) */
  resetStats(): void {
    this.stats = {
      totalDecisions: 0,
      escalations: 0,
      byModel: {},
      byReason: {},
      estimatedSavings: 0,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /** Resolve model tier aliases (__CHEAP__, __MEDIUM__, __EXPENSIVE__) */
  private resolveModelAlias(model: string): string {
    switch (model) {
      case '__CHEAP__': return this.cheapModel;
      case '__MEDIUM__': return this.mediumModel;
      case '__EXPENSIVE__': return this.expensiveModel;
      default: return model;
    }
  }

  /** Rough check if model A is cheaper than model B */
  private isCheaperThan(modelA: string, modelB: string): boolean {
    const tier = (m: string): number => {
      if (m === this.cheapModel) return 0;
      if (m === this.mediumModel) return 1;
      if (m === this.expensiveModel) return 2;
      return 1; // unknown = medium
    };
    return tier(modelA) < tier(modelB);
  }

  /** Record a routing decision in stats */
  private recordDecision(model: string, reason: string): void {
    this.stats.byModel[model] = (this.stats.byModel[model] || 0) + 1;
    this.stats.byReason[reason] = (this.stats.byReason[reason] || 0) + 1;

    // Estimate savings when using a cheaper model
    if (model !== this.expensiveModel) {
      this.stats.estimatedSavings += 0.01; // rough per-request savings
    }
  }
}
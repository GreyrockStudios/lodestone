/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Intent Prediction
 *
 * Lightweight classifier that predicts user intent from conversation context.
 * Inspired by Pask's IntentFlow model, but simpler and rule-based.
 *
 * Intent categories:
 * - question: User wants information
 * - task: User wants something done
 * - monitoring: User wants a status check
 * - follow-up: User is continuing a previous conversation
 * - correction: User is correcting previous output
 * - proactive: Agent should be proactive (heartbeat context)
 * - social: Greetings, thanks, casual chat
 * - ambiguous: Can't determine intent clearly
 *
 * This is a fast, deterministic classifier — no LLM needed.
 * It uses pattern matching, context cues, and conversation history
 * to predict what the user needs before they fully articulate it.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntentCategory =
  | 'question'
  | 'task'
  | 'monitoring'
  | 'follow-up'
  | 'correction'
  | 'proactive'
  | 'social'
  | 'ambiguous';

export type IntentUrgency = 'low' | 'medium' | 'high' | 'critical';

export interface IntentPredictionResult {
  /** The predicted intent category */
  category: IntentCategory;
  /** Confidence in the prediction (0-1) */
  confidence: number;
  /** Secondary intent (if mixed signals) */
  secondaryCategory?: IntentCategory;
  /** Secondary confidence */
  secondaryConfidence?: number;
  /** Urgency level */
  urgency: IntentUrgency;
  /** Suggested agent behavior */
  suggestedBehavior: string;
  /** Which patterns matched */
  matchedPatterns: string[];
  /** Whether this prediction should trigger proactive behavior */
  proactive: boolean;
}

export interface IntentHistoryEntry {
  /** The user message that triggered this prediction */
  message: string;
  /** The predicted intent */
  prediction: IntentPredictionResult;
  /** Whether the prediction was correct (validated later) */
  correct?: boolean;
  /** Timestamp */
  timestamp: string;
}

export interface IntentPredictionConfig {
  /** Directory for storing intent history */
  dataDir: string;
  /** Maximum history entries to keep */
  maxHistory?: number;
  /** Minimum confidence to consider a prediction valid */
  minConfidence?: number;
  /** Whether to enable proactive mode */
  enableProactive?: boolean;
}

// ─── Intent Patterns ─────────────────────────────────────────────────────────

const INTENT_PATTERNS: Array<{
  category: IntentCategory;
  patterns: RegExp[];
  urgency: IntentUrgency;
  behavior: string;
  proactive: boolean;
  weight: number;
}> = [
  // Question intent
  {
    category: 'question',
    patterns: [
      /^(?:what|who|where|when|why|how|which|can you|could you explain|tell me about)\b/i,
      /\?(?:\s|$)/,
      /^(?:explain|describe|clarify|define|elaborate)\b/i,
      /^(?:I(?:'m| am)?\s+)?(?:curious|wondering|interested)\b/i,
      /\b(?:does|is|are|was|were|will|would|should|can|could|might)\s+\S+\s+(?:support|have|use|include|allow|need|require)\b/i,
    ],
    urgency: 'medium',
    behavior: 'Provide clear, factual information. Cite wiki sources when available.',
    proactive: false,
    weight: 1.0,
  },
  // Task intent
  {
    category: 'task',
    patterns: [
      /^(?:create|build|make|set up|configure|add|remove|delete|update|fix|implement|deploy|write|draft|compose)\b/i,
      /^(?:I need|I want|please|can you)\s+(?:to\s+)?(?:create|build|make|set up|configure|add|remove|delete|update|fix|implement|deploy|write|draft)\b/i,
      /^(?:let's|let us)\s+(?:create|build|make|set up|configure|add|remove|update|fix|implement|deploy|write)\b/i,
      /^(?:help me|I need help)\s+(?:create|building|making|setting up|configuring|adding|removing|fixing|implementing|writing)\b/i,
    ],
    urgency: 'high',
    behavior: 'Execute the task. Confirm scope before starting. Report progress and result.',
    proactive: false,
    weight: 1.2,
  },
  // Monitoring intent
  {
    category: 'monitoring',
    patterns: [
      /^(?:check|status|health|monitor|how is|what's the state of)\b/i,
      /^(?:is\s+\S+\s+(?:up|down|running|working|healthy|ok|fine))\b/i,
      /\b(?:uptime|downtime|performance|metrics|logs|alerts)\b/i,
      /^(?:show me|display|list)\s+(?:the\s+)?(?:status|health|state|metrics|logs)\b/i,
    ],
    urgency: 'medium',
    behavior: 'Check current state and report. Use health endpoints. Be specific about what\'s working and what\'s not.',
    proactive: false,
    weight: 0.9,
  },
  // Follow-up intent
  {
    category: 'follow-up',
    patterns: [
      /^(?:and|also|additionally|moreover|furthermore|then|next)\b/i,
      /^(?:what about|how about|and the|what else)\b/i,
      /^(?:I also|me too|same here|continuing)\b/i,
      /^(?:yes|yeah|right|correct|exactly|ok|okay|sure)\b/i,
      /^(?:no|nope|not that|different|instead)\b/i,
    ],
    urgency: 'medium',
    behavior: 'Continue the current task or topic. Reference previous context. Don\'t restart from scratch.',
    proactive: false,
    weight: 0.8,
  },
  // Correction intent
  {
    category: 'correction',
    patterns: [
      /^(?:no|not|wrong|that's not|actually|instead|I meant|what I meant)\b/i,
      /^(?:don't|doesn't|didn't|shouldn't|stop)\b/i,
      /\b(?:incorrect|inaccurate|mistake|error|fix that|try again|redo)\b/i,
      /^(?:I said|I was asking about|I wanted)\b/i,
    ],
    urgency: 'high',
    behavior: 'Acknowledge the correction. Adjust the approach. Extract the behavioral rule for future sessions.',
    proactive: false,
    weight: 1.3,
  },
  // Proactive intent (heartbeat/system-initiated)
  {
    category: 'proactive',
    patterns: [
      /^(?:heartbeat|check-in|scheduled|automated)\b/i,
      /^(?:what needs doing|what's pending|anything to do)\b/i,
      /^(?:morning brief|daily check|nightly|weekly)\b/i,
    ],
    urgency: 'low',
    behavior: 'Check pending items, scheduled tasks, and improvements. Take action on low-risk items. Report status.',
    proactive: true,
    weight: 1.0,
  },
  // Social intent
  {
    category: 'social',
    patterns: [
      /^(?:hi|hello|hey|good morning|good afternoon|good evening|yo|sup)\b/i,
      /^(?:thanks|thank you|thx|appreciate|great job|nice|awesome)\b/i,
      /^(?:bye|goodbye|see you|talk later|night|cya)\b/i,
      /^(?:how are you|how's it going|what's up)\b/i,
    ],
    urgency: 'low',
    behavior: 'Acknowledge briefly. Don\'t over-engage with social pleasantries. Stay ready for task requests.',
    proactive: false,
    weight: 0.5,
  },
];

// ─── Urgency Indicators ──────────────────────────────────────────────────────

const URGENCY_BOOSTERS: Array<{ pattern: RegExp; boost: number }> = [
  { pattern: /\b(?:urgent|asap|emergency|critical|now|immediately|right away)\b/i, boost: 2 },
  { pattern: /\b(?:important|priority|deadline|today|tonight)\b/i, boost: 1 },
  { pattern: /\b(?:when you have time|no rush|whenever|eventually)\b/i, boost: -1 },
  { pattern: /\b(?:broken|down|not working|error|fail|crash)\b/i, boost: 1.5 },
];

// ─── Context Signals ──────────────────────────────────────────────────────────

interface ContextSignals {
  /** Is this a heartbeat/scheduled message? */
  isHeartbeat: boolean;
  /** Number of recent messages in this conversation */
  recentMessageCount: number;
  /** Time since last user message (ms) */
  timeSinceLastMessage: number | null;
  /** Whether there's an active task in session state */
  hasActiveTask: boolean;
  /** Whether there are pending watchdog items */
  hasPendingWatchdog: boolean;
  /** Whether there are scheduled cron jobs due */
  hasPendingCron: boolean;
}

// ─── Intent Prediction System ─────────────────────────────────────────────────

export class IntentPredictor {
  private history: IntentHistoryEntry[] = [];
  private config: IntentPredictionConfig;
  private filePath: string;
  private loaded = false;
  private logger = getLogger('IntentPredictor');

  // Track calibration: category -> correct count / total count
  private calibration: Record<string, { correct: number; total: number }> = {
    question: { correct: 0, total: 0 },
    task: { correct: 0, total: 0 },
    monitoring: { correct: 0, total: 0 },
    'follow-up': { correct: 0, total: 0 },
    correction: { correct: 0, total: 0 },
    proactive: { correct: 0, total: 0 },
    social: { correct: 0, total: 0 },
    ambiguous: { correct: 0, total: 0 },
  };

  constructor(config: IntentPredictionConfig) {
    this.config = config;
    this.filePath = join(config.dataDir, 'intent-history.json');
  }

  /** Initialize by loading history and calibration */
  async init(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      this.history = parsed.history || [];
      this.calibration = parsed.calibration || this.calibration;
      this.logger.info('Loaded intent history entries', { count: this.history.length });
    } catch {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      await this.save();
    }
    this.loaded = true;
  }

  /**
   * Predict the intent of a user message.
   * Uses pattern matching and context — no LLM.
   */
  predict(message: string, context?: Partial<ContextSignals>): IntentPredictionResult {
    const ctx: ContextSignals = {
      isHeartbeat: context?.isHeartbeat || false,
      recentMessageCount: context?.recentMessageCount || 0,
      timeSinceLastMessage: context?.timeSinceLastMessage || null,
      hasActiveTask: context?.hasActiveTask || false,
      hasPendingWatchdog: context?.hasPendingWatchdog || false,
      hasPendingCron: context?.hasPendingCron || false,
    };

    // Override for heartbeat messages
    if (ctx.isHeartbeat) {
      return {
        category: 'proactive',
        confidence: 0.95,
        urgency: 'low',
        suggestedBehavior: 'Check pending items, scheduled tasks, and improvements. Take action on low-risk items.',
        matchedPatterns: ['heartbeat-context'],
        proactive: true,
      };
    }

    // Score each category
    const scores: Array<{ category: IntentCategory; score: number; patterns: string[] }> = [];

    for (const intentDef of INTENT_PATTERNS) {
      let score = 0;
      const matchedPatterns: string[] = [];

      for (const pattern of intentDef.patterns) {
        if (pattern.test(message)) {
          score += intentDef.weight;
          matchedPatterns.push(pattern.source.slice(0, 50));
        }
      }

      // Context boosts
      if (ctx.hasActiveTask && intentDef.category === 'follow-up') {
        score += 0.5;
      }
      if (ctx.hasPendingWatchdog && intentDef.category === 'monitoring') {
        score += 0.3;
      }
      if (ctx.hasPendingCron && intentDef.category === 'proactive') {
        score += 0.3;
      }
      if (ctx.recentMessageCount > 3 && intentDef.category === 'follow-up') {
        score += 0.2;
      }

      if (score > 0) {
        scores.push({
          category: intentDef.category,
          score,
          patterns: matchedPatterns,
        });
      }
    }

    // Sort by score
    scores.sort((a, b) => b.score - a.score);

    // Calculate urgency
    let urgency: IntentUrgency = 'medium';
    for (const { pattern, boost } of URGENCY_BOOSTERS) {
      if (pattern.test(message)) {
        const urgencyLevels: IntentUrgency[] = ['low', 'medium', 'high', 'critical'];
        const currentIdx = urgencyLevels.indexOf(urgency);
        const newIdx = Math.min(3, Math.max(0, currentIdx + Math.round(boost)));
        urgency = urgencyLevels[newIdx];
      }
    }

    // Determine result
    if (scores.length === 0) {
      return {
        category: 'ambiguous',
        confidence: 0.3,
        urgency: 'medium',
        suggestedBehavior: 'Ask for clarification. The intent is unclear.',
        matchedPatterns: [],
        proactive: false,
      };
    }

    const topIntent = INTENT_PATTERNS.find(i => i.category === scores[0].category)!;
    const topScore = scores[0].score;
    const secondScore = scores.length > 1 ? scores[1].score : 0;

    // Normalize confidence (rough scale)
    const confidence = Math.min(0.99, 0.4 + (topScore * 0.15));

    // If top two categories are very close, report secondary intent
    const secondaryCategory = secondScore > topScore * 0.6 ? scores[1].category : undefined;
    const secondaryConfidence = secondaryCategory ? Math.min(0.9, 0.3 + (secondScore * 0.15)) : undefined;

    return {
      category: topIntent.category,
      confidence,
      secondaryCategory,
      secondaryConfidence,
      urgency,
      suggestedBehavior: topIntent.behavior,
      matchedPatterns: scores[0].patterns,
      proactive: topIntent.proactive,
    };
  }

  /**
   * Record a prediction for calibration tracking.
   * Call this when you later learn whether the prediction was correct.
   */
  async recordOutcome(message: string, prediction: IntentPredictionResult, correct: boolean): Promise<void> {
    const entry: IntentHistoryEntry = {
      message: message.slice(0, 200),
      prediction,
      correct,
      timestamp: new Date().toISOString(),
    };

    this.history.push(entry);
    this.calibration[prediction.category].total++;
    if (correct) {
      this.calibration[prediction.category].correct++;
    }

    // Evict old entries
    const maxHistory = this.config.maxHistory || 500;
    if (this.history.length > maxHistory) {
      this.history = this.history.slice(-maxHistory);
    }

    await this.save();
  }

  /**
   * Get calibration accuracy by category.
   */
  getCalibration(): Record<IntentCategory, { accuracy: number; samples: number }> {
    const result = {} as Record<IntentCategory, { accuracy: number; samples: number }>;
    for (const [category, data] of Object.entries(this.calibration)) {
      result[category as IntentCategory] = {
        accuracy: data.total > 0 ? data.correct / data.total : 0,
        samples: data.total,
      };
    }
    return result;
  }

  /**
   * Get recent predictions.
   */
  getRecentHistory(limit = 10): IntentHistoryEntry[] {
    return this.history.slice(-limit);
  }

  /**
   * Get the suggested behavior for a message, formatted for prompt injection.
   */
  getBehaviorForPrompt(message: string, context?: Partial<ContextSignals>): string {
    const prediction = this.predict(message, context);

    if (prediction.confidence < (this.config.minConfidence || 0.4)) {
      return '';
    }

    return `## Predicted Intent\nCategory: ${prediction.category} (confidence: ${(prediction.confidence * 100).toFixed(0)}%)\nUrgency: ${prediction.urgency}\nSuggested behavior: ${prediction.suggestedBehavior}`;
  }

  /**
   * Get statistics.
   */
  getStats(): { totalPredictions: number; byCategory: Record<string, number>; avgConfidence: number } {
    const byCategory: Record<string, number> = {};
    let totalConfidence = 0;

    for (const entry of this.history) {
      byCategory[entry.prediction.category] = (byCategory[entry.prediction.category] || 0) + 1;
      totalConfidence += entry.prediction.confidence;
    }

    return {
      totalPredictions: this.history.length,
      byCategory,
      avgConfidence: this.history.length > 0 ? totalConfidence / this.history.length : 0,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    const data = {
      history: this.history,
      calibration: this.calibration,
    };
    await mkdir(join(this.filePath, '..'), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
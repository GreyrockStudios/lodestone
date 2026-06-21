/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Behavioral Learning
 *
 * When a user corrects an agent response, this subsystem extracts
 * the correction into a persistent behavioral rule. The rule is
 * injected into future prompts automatically.
 *
 * Inspired by WASP's behavioral learning loop, but simpler:
 * - Detect corrections in conversation (explicit or implicit)
 * - Extract the rule via pattern matching (no LLM needed for most)
 * - Store as behavioral rules in the identity system
 * - Inject into future prompt contexts
 *
 * Rule format:
 *   When <trigger>, <correct_behavior> (not <incorrect_behavior>)
 *
 * Example:
 *   When user says "format it as a table", they mean markdown table, not code block.
 *   When user corrects "that's not what I meant", ask for clarification rather than guessing.
 *   When writing CSS, prefer Tailwind utility classes over custom properties.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BehavioralRule {
  /** Unique ID */
  id: string;
  /** When this trigger fires */
  trigger: string;
  /** What to do instead */
  correctBehavior: string;
  /** What NOT to do */
  incorrectBehavior?: string;
  /** How this rule was learned */
  source: 'explicit-correction' | 'implicit-correction' | 'manual' | 'sleep-extraction';
  /** When this rule was learned */
  learnedAt: string;
  /** How many times this rule has been applied */
  applicationCount: number;
  /** Last time this rule was applied */
  lastAppliedAt?: string;
  /** Confidence in this rule (0-1) */
  confidence: number;
  /** Whether this rule is active */
  active: boolean;
  /** Tags for categorization */
  tags: string[];
}

export interface CorrectionInput {
  /** The user's correction message */
  message: string;
  /** The agent's response that prompted the correction */
  precedingResponse: string;
  /** The context of the conversation */
  conversationContext?: string;
  /** Timestamp */
  timestamp?: string;
}

export interface BehavioralLearningConfig {
  /** Directory for storing rules */
  dataDir: string;
  /** Maximum rules to keep (LRU eviction) */
  maxRules?: number;
  /** Minimum confidence for a rule to be active */
  minConfidence?: number;
}

// ─── Correction Detection Patterns ─────────────────────────────────────────────

const EXPLICIT_CORRECTION_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /\b(no|not|don't|doesn't|didn't|wrong|incorrect|that's not|actually|instead)\b/i, type: 'negation' },
  { pattern: /\b(I meant|what I meant|I wanted|I was looking for)\b/i, type: 'intent-clarification' },
  { pattern: /\b(try again|redo|start over|different approach)\b/i, type: 'retry' },
  { pattern: /\b(too|also|additionally|and also)\b/i, type: 'addition' },
  { pattern: /\b(format|style|layout|arrange)\b.*\b(as|like|into)\b/i, type: 'format-correction' },
  { pattern: /\b(use|prefer|always|never)\b/i, type: 'preference' },
];

const IMPLICIT_CORRECTION_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /^(yes|right|correct|good|perfect|exactly)\b/i, type: 'positive-reinforcement' },
  { pattern: /\b(more|less|simpler|shorter|longer|detailed|brief)\b/i, type: 'adjustment' },
  { pattern: /\b(can you|could you|please)\b/i, type: 'polite-request' },
];

// ─── Behavioral Learning System ──────────────────────────────────────────────

export class BehavioralLearning {
  private rules: Map<string, BehavioralRule> = new Map();
  private config: BehavioralLearningConfig;
  private filePath: string;
  private loaded = false;
  private logger = getLogger('BehavioralLearning');

  constructor(config: BehavioralLearningConfig) {
    this.config = config;
    this.filePath = join(config.dataDir, 'behavioral-rules.json');
  }

  /** Initialize by loading existing rules */
  async init(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      for (const rule of parsed) {
        this.rules.set(rule.id, rule);
      }
      this.logger.info('Loaded behavioral rules', { count: this.rules.size });
    } catch {
      // First run — no rules yet
      await mkdir(join(this.filePath, '..'), { recursive: true });
      await this.save();
    }
    this.loaded = true;
  }

  /** Detect if a message is a correction */
  detectCorrection(input: CorrectionInput): { isCorrection: boolean; type: string; confidence: number } {
    const message = input.message.toLowerCase();

    // Check explicit correction patterns first
    for (const { pattern, type } of EXPLICIT_CORRECTION_PATTERNS) {
      if (pattern.test(message)) {
        return { isCorrection: true, type, confidence: 0.85 };
      }
    }

    // Check implicit correction patterns
    for (const { pattern, type } of IMPLICIT_CORRECTION_PATTERNS) {
      if (pattern.test(message)) {
        return { isCorrection: true, type, confidence: 0.5 };
      }
    }

    // Check for follow-up that contradicts the preceding response
    if (input.precedingResponse) {
      const prevWords = new Set(input.precedingResponse.toLowerCase().split(/\s+/).filter(w => w.length > 4));
      const negationWords = ['not', 'no', "don't", 'never', 'wrong', 'instead', 'different'];
      const hasNegation = negationWords.some(w => message.includes(w));
      const hasOverlap = prevWords.size > 0 && [...prevWords].some(w => message.includes(w));

      if (hasNegation && hasOverlap) {
        return { isCorrection: true, type: 'contradiction', confidence: 0.7 };
      }
    }

    return { isCorrection: false, type: 'none', confidence: 0 };
  }

  /**
   * Extract a behavioral rule from a correction.
   * Uses pattern matching — no LLM needed for most cases.
   */
  extractRule(input: CorrectionInput): BehavioralRule | null {
    const detection = this.detectCorrection(input);
    if (!detection.isCorrection) return null;

    const message = input.message.trim();
    const timestamp = input.timestamp || new Date().toISOString();
    const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let trigger: string;
    let correctBehavior: string;
    let incorrectBehavior: string | undefined;
    let tags: string[] = [detection.type];

    switch (detection.type) {
      case 'negation': {
        // "No, use tables not bullet points" → When formatting data, use tables not bullet points
        trigger = 'general response';
        correctBehavior = message.replace(/^(no,?\s*|not\s*|don't\s*)/i, '').trim();
        // Try to extract the negated part
        const notMatch = message.match(/\bnot\s+(.+?)(?:\s*[,;.]|\s*$)/i);
        if (notMatch) {
          incorrectBehavior = notMatch[1];
        }
        break;
      }
      case 'intent-clarification': {
        // "I meant to sort by date" → When sorting, sort by date
        const meantMatch = message.match(/(?:I meant|what I meant|I was looking for|I wanted)\s+(.+)/i);
        trigger = 'user intent';
        correctBehavior = meantMatch ? meantMatch[1].trim() : message;
        break;
      }
      case 'retry': {
        // "Try again with X" → When retrying, use X
        trigger = 'task retry';
        correctBehavior = message.replace(/^(try again|redo|start over)\s*(with|using|by)?\s*/i, '').trim() || 'use a different approach';
        break;
      }
      case 'format-correction': {
        // "Format it as a table" → When presenting data, use table format
        const formatMatch = message.match(/(?:format|style|layout|arrange)\s+(.+?)\s+(?:as|like|into)\s+(.+)/i);
        if (formatMatch) {
          trigger = `formatting ${formatMatch[1]}`;
          correctBehavior = `use ${formatMatch[2]} format`;
          incorrectBehavior = `use other formats for ${formatMatch[1]}`;
        } else {
          trigger = 'formatting';
          correctBehavior = message;
        }
        tags.push('formatting');
        break;
      }
      case 'preference': {
        // "Always use tabs not spaces" → When indenting, use tabs not spaces
        const prefMatch = message.match(/(?:always|never|prefer|use)\s+(.+)/i);
        trigger = 'user preference';
        correctBehavior = prefMatch ? prefMatch[1].trim() : message;
        tags.push('preference');
        break;
      }
      case 'addition': {
        // "Also include X" → When responding, include X
        const alsoMatch = message.match(/(?:too|also|additionally|and also)\s+(?:include|add|show|mention)?\s*(.+)/i);
        trigger = 'completeness';
        correctBehavior = alsoMatch ? `include ${alsoMatch[1].trim()}` : `also ${message}`;
        tags.push('completeness');
        break;
      }
      case 'contradiction': {
        trigger = 'response accuracy';
        correctBehavior = `contradicts previous: ${message}`;
        incorrectBehavior = input.precedingResponse?.slice(0, 100);
        tags.push('accuracy');
        break;
      }
      case 'positive-reinforcement': {
        // "Yes, exactly" → reinforces current behavior, not a correction
        // We track these but don't create new rules from them
        return null;
      }
      case 'adjustment': {
        // "Make it shorter" → When generating, be more concise
        const adjMatch = message.match(/(?:make it|be more|be less|can you be)\s+(.+)/i);
        if (adjMatch) {
          trigger = 'response style';
          correctBehavior = adjMatch[1].trim();
          tags.push('style');
        } else {
          trigger = 'response style';
          correctBehavior = message;
        }
        break;
      }
      default: {
        trigger = 'general';
        correctBehavior = message;
      }
    }

    // Don't create rules that are too short or too long
    if (correctBehavior.length < 5 || correctBehavior.length > 200) return null;

    // Check for duplicates
    for (const existing of this.rules.values()) {
      if (existing.trigger === trigger && existing.correctBehavior === correctBehavior) {
        // Reinforce existing rule
        existing.applicationCount++;
        existing.confidence = Math.min(1, existing.confidence + 0.05);
        existing.lastAppliedAt = timestamp;
        this.save();
        return existing;
      }
    }

    const rule: BehavioralRule = {
      id,
      trigger,
      correctBehavior,
      incorrectBehavior,
      source: detection.confidence >= 0.7 ? 'explicit-correction' : 'implicit-correction',
      learnedAt: timestamp,
      applicationCount: 0,
      confidence: detection.confidence,
      active: true,
      tags,
    };

    this.rules.set(id, rule);
    this.evictIfNeeded();
    this.save();
    return rule;
  }

  /**
   * Add a manual rule (e.g., from SOUL.md or identity config).
   */
  addManualRule(trigger: string, correctBehavior: string, incorrectBehavior?: string, tags?: string[]): BehavioralRule {
    const id = `rule-manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const rule: BehavioralRule = {
      id,
      trigger,
      correctBehavior,
      incorrectBehavior,
      source: 'manual',
      learnedAt: new Date().toISOString(),
      applicationCount: 0,
      confidence: 1.0,
      active: true,
      tags: tags || [],
    };

    this.rules.set(id, rule);
    this.save();
    return rule;
  }

  /**
   * Get all active rules, sorted by confidence.
   */
  getActiveRules(): BehavioralRule[] {
    const minConfidence = this.config.minConfidence ?? 0.5;
    return Array.from(this.rules.values())
      .filter(r => r.active && r.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Format active rules as a prompt injection block.
   * This gets injected into the system prompt for every conversation.
   */
  formatRulesForPrompt(maxRules?: number): string {
    const rules = this.getActiveRules().slice(0, maxRules || 20);

    if (rules.length === 0) return '';

    const lines = rules.map(r => {
      let line = `When ${r.trigger}, ${r.correctBehavior}`;
      if (r.incorrectBehavior) {
        line += ` (not ${r.incorrectBehavior})`;
      }
      return line;
    });

    return `## Behavioral Rules (learned from corrections)\n${lines.map(l => `- ${l}`).join('\n')}`;
  }

  /**
   * Mark a rule as applied (when it matches a conversation context).
   */
  markApplied(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.applicationCount++;
      rule.lastAppliedAt = new Date().toISOString();
      this.save();
    }
  }

  /**
   * Deactivate a rule (e.g., when it's contradicted by newer data).
   */
  deactivate(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.active = false;
      this.save();
    }
  }

  /** Get all rules */
  listRules(): BehavioralRule[] {
    return Array.from(this.rules.values()).sort((a, b) =>
      new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime()
    );
  }

  /** Get a specific rule */
  getRule(id: string): BehavioralRule | undefined {
    return this.rules.get(id);
  }

  /** Get statistics */
  getStats(): { total: number; active: number; bySource: Record<string, number>; avgConfidence: number } {
    const rules = Array.from(this.rules.values());
    const active = rules.filter(r => r.active);
    const bySource: Record<string, number> = {};
    for (const r of rules) {
      bySource[r.source] = (bySource[r.source] || 0) + 1;
    }
    return {
      total: rules.length,
      active: active.length,
      bySource,
      avgConfidence: rules.length > 0 ? rules.reduce((s, r) => s + r.confidence, 0) / rules.length : 0,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    const maxRules = this.config.maxRules || 100;
    if (this.rules.size <= maxRules) return;

    // Evict lowest confidence, least recently applied rules
    const sorted = Array.from(this.rules.values())
      .sort((a, b) => {
        // Active rules with higher confidence and more applications stay
        const aScore = (a.active ? 10 : 0) + a.confidence + Math.log2(a.applicationCount + 1);
        const bScore = (b.active ? 10 : 0) + b.confidence + Math.log2(b.applicationCount + 1);
        return aScore - bScore;
      });

    while (this.rules.size > maxRules) {
      const evicted = sorted.shift();
      if (evicted) this.rules.delete(evicted.id);
    }
  }

  private async save(): Promise<void> {
    const data = Array.from(this.rules.values());
    await mkdir(join(this.filePath, '..'), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
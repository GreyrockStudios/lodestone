/**
 * Lodestone — Contradiction Detection
 *
 * Maintains a belief log and detects when new statements contradict
 * past ones. When a contradiction is found, the agent flags itself
 * and asks the user which statement is correct.
 *
 * Detection methods (all deterministic, no LLM):
 * 1. Negation detection: "X is true" vs "X is false"
 * 2. Numeric conflict: "cost is $50" vs "cost is $100"
 * 3. Quantity change: "10 items" vs "5 items" with no explanation
 * 4. Status reversal: "it's working" vs "it's broken"
 *
 * Beliefs are persisted to data/beliefs.json for survival across restarts.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BeliefContext {
  /** Session ID where the belief was stated */
  sessionId: string;
  /** Timestamp of the statement */
  timestamp: string;
  /** Topic tags for categorization */
  topics: string[];
  /** The user message that prompted this belief */
  userMessage?: string;
}

export interface Belief {
  /** Unique belief ID */
  id: string;
  /** The belief statement (extracted claim) */
  statement: string;
  /** Normalized form for comparison */
  normalized: string;
  /** Context when the belief was recorded */
  context: BeliefContext;
  /** When this belief was stored */
  recordedAt: string;
}

export type ConflictType =
  | 'negation'
  | 'numeric-conflict'
  | 'quantity-change'
  | 'status-reversal';

export interface ContradictionResult {
  /** The new statement that triggered the contradiction */
  newStatement: string;
  /** The existing belief that is contradicted */
  existingBelief: Belief;
  /** Type of conflict detected */
  conflictType: ConflictType;
  /** Human-readable description of the conflict */
  description: string;
  /** Suggested resolution */
  suggestedResolution: string;
}

export interface ContradictionRecord extends ContradictionResult {
  /** When the contradiction was detected */
  detectedAt: string;
  /** The new belief that was still recorded */
  newBeliefId: string;
}

export interface ContradictionDetectorConfig {
  /** Directory for storing belief data */
  dataDir: string;
  /** Maximum beliefs to retain (default: 500) */
  maxBeliefs?: number;
  /** Maximum contradiction records to keep (default: 100) */
  maxContradictions?: number;
}

// ─── Normalization & Pattern Matching ─────────────────────────────────────

/**
 * Normalize a statement for comparison: lowercase, trim, collapse whitespace,
 * remove trailing punctuation.
 */
function normalizeStatement(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.;,!?]+$/, '');
}

/**
 * Extract the core claim from a sentence by removing leading qualifiers.
 * "I think the cost is $50" → "the cost is $50"
 */
function extractClaim(s: string): string {
  return s
    .replace(/^(?:i think|i believe|probably|likely|maybe|perhaps|it seems that)\s+/i, '')
    .trim();
}

// Negation patterns: "X is true" vs "X is false", "X works" vs "X doesn't work"
const NEGATION_PATTERNS: Array<{
  match: RegExp;
  extract: (m: RegExpMatchArray) => { subject: string; polarity: 'positive' | 'negative' };
}> = [
  // "X is true" / "X is false"
  {
    match: /^(.+?)\s+is\s+(true|false|not true|incorrect|correct)\b/i,
    extract: (m) => ({ subject: m[1].trim(), polarity: /false|not true|incorrect/i.test(m[2]) ? 'negative' : 'positive' }),
  },
  // "X is working" / "X is broken" / "X is not working"
  {
    match: /^(.+?)\s+(?:is|are|was|were)\s+(working|broken|functional|not working|down|up|operational|offline|online)\b/i,
    extract: (m) => ({
      subject: m[1].trim(),
      polarity: /broken|not working|down|offline/i.test(m[2]) ? 'negative' : 'positive',
    }),
  },
  // "X works" / "X doesn't work" / "X does not work"
  {
    match: /^(.+?)\s+(works|doesn'?t work|does not work|failed?|succeeded?)\b/i,
    extract: (m) => ({
      subject: m[1].trim(),
      polarity: /doesn.?t work|does not work|failed?/i.test(m[2]) ? 'negative' : 'positive',
    }),
  },
  // "X is enabled" / "X is disabled"
  {
    match: /^(.+?)\s+(?:is|are|was|were)\s+(enabled|disabled|active|inactive|on|off)\b/i,
    extract: (m) => ({
      subject: m[1].trim(),
      polarity: /disabled|inactive|off/i.test(m[2]) ? 'negative' : 'positive',
    }),
  },
];

// Numeric patterns: "cost is $50" vs "cost is $100"
const NUMERIC_PATTERNS: Array<{
  match: RegExp;
  extract: (m: RegExpMatchArray) => { subject: string; value: string; unit?: string };
}> = [
  // "$50", "$100.00"
  {
    match: /^(.+?)\s+(?:is|costs?|equals?|was|were)\s+\$?([\d,.]+)\s*(billion|million|thousand|k|m|b)?\b/i,
    extract: (m) => ({ subject: m[1].trim(), value: m[2].replace(/,/g, ''), unit: m[3] }),
  },
  // "10 items", "5 users"
  {
    match: /^(.+?)\s+(?:is|are|was|were|has|have|contains?)\s+([\d,.]+)\s*(items?|users?|files?|lines?|rows?|records?|entries?|tasks?|jobs?|nodes?|edges?)\b/i,
    extract: (m) => ({ subject: m[1].trim(), value: m[2].replace(/,/g, ''), unit: m[3] }),
  },
  // "version 2.0", "version 3.1"
  {
    match: /^(.+?)\s+(?:is|version|v)\s*([\d.]+)\b/i,
    extract: (m) => ({ subject: m[1].trim().replace(/\s+version$/, ''), value: m[2] }),
  },
  // Generic: "X is Y units" where Y is a number
  {
    match: /^(.+?)\s+(?:is|are|was|were)\s+([\d,.]+)\s*(ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|%|percent|degrees?|mb|gb|tb)\b/i,
    extract: (m) => ({ subject: m[1].trim(), value: m[2].replace(/,/g, ''), unit: m[3] }),
  },
];

// ─── Contradiction Detector ───────────────────────────────────────────────────

export class ContradictionDetector {
  private beliefs: Map<string, Belief> = new Map();
  private contradictions: ContradictionRecord[] = [];
  private config: Required<ContradictionDetectorConfig>;
  private beliefsFile: string;
  private contradictionsFile: string;
  private log = getLogger('contradiction-detector');
  private loaded = false;

  constructor(config: ContradictionDetectorConfig) {
    this.config = {
      dataDir: config.dataDir,
      maxBeliefs: config.maxBeliefs ?? 500,
      maxContradictions: config.maxContradictions ?? 100,
    };
    this.beliefsFile = join(this.config.dataDir, 'beliefs.json');
    this.contradictionsFile = join(this.config.dataDir, 'contradictions.json');
  }

  /** Initialize by loading stored beliefs and contradiction history */
  async init(): Promise<void> {
    try {
      const data = await readFile(this.beliefsFile, 'utf-8');
      const beliefs: Belief[] = JSON.parse(data);
      for (const b of beliefs) {
        this.beliefs.set(b.id, b);
      }
      this.log.info(`Loaded ${this.beliefs.size} beliefs`);
    } catch {
      await mkdir(dirname(this.beliefsFile), { recursive: true });
      await writeFile(this.beliefsFile, '[]', 'utf-8');
    }

    try {
      const data = await readFile(this.contradictionsFile, 'utf-8');
      this.contradictions = JSON.parse(data);
      this.log.info(`Loaded ${this.contradictions.length} contradiction records`);
    } catch {
      await writeFile(this.contradictionsFile, '[]', 'utf-8');
    }

    this.loaded = true;
  }

  /**
   * Record a belief from a statement.
   * Extracts the core claim, normalizes it, and stores it.
   * Returns the belief ID.
   */
  async recordBelief(statement: string, context: BeliefContext): Promise<string> {
    const claim = extractClaim(statement);
    const normalized = normalizeStatement(claim);
    const id = `belief-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const belief: Belief = {
      id,
      statement: claim,
      normalized,
      context,
      recordedAt: new Date().toISOString(),
    };

    this.beliefs.set(id, belief);

    // Enforce max beliefs limit (FIFO eviction)
    if (this.beliefs.size > this.config.maxBeliefs) {
      const oldest = Array.from(this.beliefs.keys())[0];
      this.beliefs.delete(oldest);
    }

    await this.saveBeliefs();
    this.log.debug('Belief recorded', { id, statement: claim.slice(0, 80) });
    return id;
  }

  /**
   * Check a new statement against stored beliefs for contradictions.
   * Returns a ContradictionResult if a contradiction is found, null otherwise.
   * Does NOT record the new statement as a belief — call recordBelief() separately.
   */
  checkContradiction(newStatement: string, context: BeliefContext): ContradictionResult | null {
    const claim = extractClaim(newStatement);
    const normalized = normalizeStatement(claim);

    // Skip very short or trivial statements
    if (normalized.length < 10) return null;

    // Check against all stored beliefs (could optimize with topic filtering)
    for (const belief of this.beliefs.values()) {
      // Skip self-comparison (same statement)
      if (belief.normalized === normalized) continue;

      const result = this.detectContradiction(normalized, claim, belief);
      if (result) {
        // Log the contradiction
        this.log.warn('Contradiction detected', {
          newStatement: claim.slice(0, 80),
          existingBelief: belief.statement.slice(0, 80),
          conflictType: result.conflictType,
        });

        return result;
      }
    }

    return null;
  }

  /**
   * Core contradiction detection logic.
   * Compares a new normalized statement against an existing belief.
   */
  private detectContradiction(
    newNormalized: string,
    newOriginal: string,
    belief: Belief
  ): ContradictionResult | null {
    // 1. Negation detection
    const negResult = this.checkNegation(newNormalized, belief);
    if (negResult) return negResult;

    // 2. Numeric conflict
    const numResult = this.checkNumericConflict(newNormalized, belief);
    if (numResult) return numResult;

    // 3. Quantity change
    const qtyResult = this.checkQuantityChange(newNormalized, belief);
    if (qtyResult) return qtyResult;

    // 4. Status reversal
    const statusResult = this.checkStatusReversal(newNormalized, belief);
    if (statusResult) return statusResult;

    return null;
  }

  /**
   * Negation detection: "X is true" vs "X is false"
   */
  private checkNegation(newNorm: string, belief: Belief): ContradictionResult | null {
    const newMatch = this.matchNegation(newNorm);
    const beliefMatch = this.matchNegation(belief.normalized);

    if (!newMatch || !beliefMatch) return null;

    // Same subject, opposite polarity = contradiction
    if (
      newMatch.subject === beliefMatch.subject &&
      newMatch.polarity !== beliefMatch.polarity
    ) {
      return {
        newStatement: newNorm,
        existingBelief: belief,
        conflictType: 'negation',
        description: `Negation conflict: "${belief.statement}" vs "${newNorm}"`,
        suggestedResolution: `These statements contradict each other. Which is correct: "${beliefMatch.subject}" is ${beliefMatch.polarity === 'positive' ? 'positive' : 'negative'} or ${newMatch.polarity === 'positive' ? 'positive' : 'negative'}?`,
      };
    }

    return null;
  }

  /**
   * Numeric conflict: "cost is $50" vs "cost is $100"
   */
  private checkNumericConflict(newNorm: string, belief: Belief): ContradictionResult | null {
    const newMatch = this.matchNumeric(newNorm);
    const beliefMatch = this.matchNumeric(belief.normalized);

    if (!newMatch || !beliefMatch) return null;

    // Same subject with different values = conflict
    if (
      newMatch.subject === beliefMatch.subject &&
      newMatch.value !== beliefMatch.value
    ) {
      // Check if the unit is the same or compatible
      const sameUnit =
        (!newMatch.unit && !beliefMatch.unit) ||
        (newMatch.unit && beliefMatch.unit &&
          newMatch.unit.toLowerCase() === beliefMatch.unit.toLowerCase());

      if (sameUnit) {
        return {
          newStatement: newNorm,
          existingBelief: belief,
          conflictType: 'numeric-conflict',
          description: `Numeric conflict: "${belief.statement}" says ${beliefMatch.value}${beliefMatch.unit ? ' ' + beliefMatch.unit : ''}, but "${newNorm}" says ${newMatch.value}${newMatch.unit ? ' ' + newMatch.unit : ''}`,
          suggestedResolution: `The value changed from ${beliefMatch.value} to ${newMatch.value}. Is this an update or an error?`,
        };
      }
    }

    return null;
  }

  /**
   * Quantity change: "10 items" vs "5 items" with no explanation
   */
  private checkQuantityChange(newNorm: string, belief: Belief): ContradictionResult | null {
    const newMatch = this.matchQuantity(newNorm);
    const beliefMatch = this.matchQuantity(belief.normalized);

    if (!newMatch || !beliefMatch) return null;

    if (
      newMatch.subject === beliefMatch.subject &&
      newMatch.unit === beliefMatch.unit &&
      newMatch.value !== beliefMatch.value
    ) {
      return {
        newStatement: newNorm,
        existingBelief: belief,
        conflictType: 'quantity-change',
        description: `Quantity change: "${belief.statement}" had ${beliefMatch.value} ${beliefMatch.unit}, now "${newNorm}" says ${newMatch.value} ${newMatch.unit}`,
        suggestedResolution: `The count changed from ${beliefMatch.value} to ${newMatch.value} ${newMatch.unit}. What caused this change?`,
      };
    }

    return null;
  }

  /**
   * Status reversal: "it's working" vs "it's broken"
   */
  private checkStatusReversal(newNorm: string, belief: Belief): ContradictionResult | null {
    const newMatch = this.matchStatus(newNorm);
    const beliefMatch = this.matchStatus(belief.normalized);

    if (!newMatch || !beliefMatch) return null;

    if (
      newMatch.subject === beliefMatch.subject &&
      newMatch.status !== beliefMatch.status
    ) {
      // One is positive, one is negative
      const newIsPositive = /working|up|online|operational|functional|enabled|active/i.test(newMatch.status);
      const beliefIsPositive = /working|up|online|operational|functional|enabled|active/i.test(beliefMatch.status);

      if (newIsPositive !== beliefIsPositive) {
        return {
          newStatement: newNorm,
          existingBelief: belief,
          conflictType: 'status-reversal',
          description: `Status reversal: "${belief.statement}" said it's ${beliefMatch.status}, but "${newNorm}" says it's ${newMatch.status}`,
          suggestedResolution: `Status changed from "${beliefMatch.status}" to "${newMatch.status}". Did something happen to cause this?`,
        };
      }
    }

    return null;
  }

  // ─── Pattern Matchers ────────────────────────────────────────────────────

  private matchNegation(
    s: string
  ): { subject: string; polarity: 'positive' | 'negative' } | null {
    for (const { match, extract } of NEGATION_PATTERNS) {
      const m = s.match(match);
      if (m) return extract(m);
    }
    return null;
  }

  private matchNumeric(
    s: string
  ): { subject: string; value: string; unit?: string } | null {
    for (const { match, extract } of NUMERIC_PATTERNS) {
      const m = s.match(match);
      if (m) return extract(m);
    }
    return null;
  }

  private matchQuantity(
    s: string
  ): { subject: string; value: string; unit: string } | null {
    // Specific quantity patterns
    const qtyPattern = /^(.+?)\s+(?:is|are|was|were|has|have|contains?)\s+([\d,.]+)\s*(items?|users?|files?|lines?|rows?|records?|entries?|tasks?|jobs?|nodes?|edges?|messages?|sessions?)\b/i;
    const m = s.match(qtyPattern);
    if (m) {
      return {
        subject: m[1].trim(),
        value: m[2].replace(/,/g, ''),
        unit: m[3].toLowerCase().replace(/s$/, ''),
      };
    }
    return null;
  }

  private matchStatus(
    s: string
  ): { subject: string; status: string } | null {
    const statusPattern = /^(.+?)\s+(?:is|are|was|were)\s+(working|broken|functional|not working|down|up|operational|offline|online|enabled|disabled|active|inactive)\b/i;
    const m = s.match(statusPattern);
    if (m) {
      return { subject: m[1].trim(), status: m[2].toLowerCase() };
    }
    return null;
  }

  // ─── Query Methods ──────────────────────────────────────────────────────

  /** Get all beliefs, optionally filtered by topic */
  getBeliefs(topic?: string): Belief[] {
    if (!topic) return Array.from(this.beliefs.values());
    return Array.from(this.beliefs.values()).filter(b =>
      b.context.topics.includes(topic)
    );
  }

  /** Get contradiction history */
  getContradictions(): ContradictionRecord[] {
    return [...this.contradictions];
  }

  /** Get a specific belief by ID */
  getBelief(id: string): Belief | undefined {
    return this.beliefs.get(id);
  }

  /** Get statistics */
  getStats(): { beliefCount: number; contradictionCount: number; byTopic: Record<string, number> } {
    const byTopic: Record<string, number> = {};
    for (const belief of this.beliefs.values()) {
      for (const topic of belief.context.topics) {
        byTopic[topic] = (byTopic[topic] || 0) + 1;
      }
    }
    return {
      beliefCount: this.beliefs.size,
      contradictionCount: this.contradictions.length,
      byTopic,
    };
  }

  /**
   * Record a contradiction finding (called internally when checkContradiction
   * finds something, or externally to log it).
   */
  async recordContradiction(result: ContradictionResult, newBeliefId: string): Promise<void> {
    const record: ContradictionRecord = {
      ...result,
      detectedAt: new Date().toISOString(),
      newBeliefId,
    };

    this.contradictions.push(record);

    // Enforce max contradictions limit
    if (this.contradictions.length > this.config.maxContradictions) {
      this.contradictions = this.contradictions.slice(-this.config.maxContradictions);
    }

    await this.saveContradictions();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private async saveBeliefs(): Promise<void> {
    const data = Array.from(this.beliefs.values());
    await mkdir(dirname(this.beliefsFile), { recursive: true });
    await writeFile(this.beliefsFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async saveContradictions(): Promise<void> {
    await mkdir(dirname(this.contradictionsFile), { recursive: true });
    await writeFile(this.contradictionsFile, JSON.stringify(this.contradictions, null, 2), 'utf-8');
  }
}
/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — A/B Prompt Testing
 *
 * Compare response quality across prompt variations with statistical
 * significance tracking and auto-promotion of winning prompts.
 *
 * Pure TypeScript, no external dependencies.
 *
 * Features:
 * - Register tests with multiple prompt variants
 * - Assign sessions to variants (round-robin or hash-based)
 * - Record outcomes with deterministic scoring
 * - Calculate statistical significance (Welch's t-test approximation)
 * - Auto-promote winning variant when significant
 * - Persists test data to data/ab-tests.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { Logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ABTest {
  id: string;
  name: string;
  description: string;
  variants: PromptVariant[];
  metric: 'satisfaction' | 'efficiency' | 'accuracy' | 'latency';
  status: 'running' | 'completed' | 'paused';
  createdAt: string;
  updatedAt: string;
  /** Assignment strategy */
  assignment?: 'round-robin' | 'hash';
}

export interface PromptVariant {
  id: string;
  promptTemplate: string;
  label: string;
}

export interface ABOutcome {
  sessionId: string;
  variantId: string;
  score: number;
  metadata: Record<string, any>;
  timestamp: string;
}

export interface VariantResult {
  variantId: string;
  label: string;
  samples: number;
  meanScore: number;
  stdDev: number;
}

export interface ABResults {
  testId: string;
  variants: VariantResult[];
  winner: string | null;
  confidence: number;
}

export interface SignificanceResult {
  testId: string;
  significant: boolean;
  pValue: number;
  confidence: number;
  betterVariant: string | null;
  recommendation: 'promote' | 'continue' | 'insufficient-data';
  details: string;
}

// ─── AB Testing ─────────────────────────────────────────────────────────────

export class ABTesting {
  private logger: Logger;
  private dataPath: string;
  private tests: Map<string, ABTest> = new Map();
  private outcomes: Map<string, ABOutcome[]> = new Map(); // testId → outcomes
  private assignmentCounters: Map<string, number> = new Map(); // testId → round-robin counter
  private history: ABTest[] = [];

  constructor(dataDir: string) {
    this.logger = new Logger({ minLevel: 'info' });
    const dir = typeof dataDir === 'string' ? dataDir : './data';
    this.dataPath = join(dir, 'ab-tests.json');
    try { mkdirSync(dirname(this.dataPath), { recursive: true }); } catch { /* exists */ }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (existsSync(this.dataPath)) {
      try {
        const data = JSON.parse(readFileSync(this.dataPath, 'utf-8'));
        // Load active tests
        if (data.tests) {
          for (const test of data.tests) {
            this.tests.set(test.id, test);
            if (test.status === 'running') {
              this.assignmentCounters.set(test.id, 0);
            }
          }
        }
        // Load outcomes
        if (data.outcomes) {
          for (const [testId, outcomes] of Object.entries(data.outcomes)) {
            this.outcomes.set(testId, outcomes as ABOutcome[]);
          }
        }
        // Load history
        if (data.history) {
          this.history = data.history;
        }
        this.logger.info(`[ABTesting] Loaded ${this.tests.size} tests, ${this.outcomes.size} outcome sets`);
      } catch (err) {
        this.logger.warn(`[ABTesting] Failed to load data: ${err}`);
      }
    }
  }

  private save(): void {
    const data = {
      tests: Array.from(this.tests.values()),
      outcomes: Object.fromEntries(this.outcomes),
      history: this.history,
    };
    try {
      writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error(`[ABTesting] Failed to save: ${err}`);
    }
  }

  // ─── Test Management ────────────────────────────────────────────────────────

  /**
   * Register a new A/B test.
   */
  registerTest(test: ABTest): void {
    if (this.tests.has(test.id)) {
      throw new Error(`A/B test '${test.id}' already exists. Use a unique test ID.`);
    }

    const now = new Date().toISOString();
    const fullTest: ABTest = {
      ...test,
      createdAt: now,
      updatedAt: now,
      assignment: test.assignment || 'round-robin',
    };

    this.tests.set(test.id, fullTest);
    this.outcomes.set(test.id, []);
    this.assignmentCounters.set(test.id, 0);
    this.save();
    this.logger.info(`[ABTesting] Registered test "${test.name}" with ${test.variants.length} variants`);
  }

  /**
   * Get the variant for a given session.
   * Uses round-robin or hash-based assignment.
   */
  getVariant(testId: string, sessionId: string): PromptVariant {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`A/B test '${testId}' not found. Use listTests() to see available tests.`);
    if (test.status !== 'running') throw new Error(`A/B test '${testId}' is not running (current status: ${test.status}). Only running tests can record outcomes.`);

    const strategy = test.assignment || 'round-robin';

    if (strategy === 'hash') {
      // Hash-based: deterministic assignment based on sessionId
      const hash = this.hashString(sessionId + testId);
      const idx = hash % test.variants.length;
      return test.variants[idx];
    } else {
      // Round-robin
      const counter = this.assignmentCounters.get(testId) || 0;
      const idx = counter % test.variants.length;
      this.assignmentCounters.set(testId, counter + 1);
      return test.variants[idx];
    }
  }

  /**
   * Record the outcome of a variant for a session.
   */
  recordResult(testId: string, variantId: string, outcome: ABOutcome): void {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`A/B test '${testId}' not found. Use listTests() to see available tests.`);

    // Validate variant belongs to test
    const variant = test.variants.find(v => v.id === variantId);
    if (!variant) throw new Error(`Variant '${variantId}' not found in A/B test '${testId}'. Check getTest() for available variants.`);

    const outcomes = this.outcomes.get(testId) || [];
    outcomes.push({
      ...outcome,
      variantId,
      timestamp: new Date().toISOString(),
    });
    this.outcomes.set(testId, outcomes);

    // Update test timestamp
    test.updatedAt = new Date().toISOString();
    this.save();

    this.logger.debug(`[ABTesting] Recorded outcome for test ${testId}, variant ${variantId}: score=${outcome.score}`);
  }

  /**
   * Get results for a test — returns per-variant statistics.
   */
  getResults(testId: string): ABResults {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`A/B test '${testId}' not found. Use listTests() to see available tests.`);

    const outcomes = this.outcomes.get(testId) || [];
    const variantResults: VariantResult[] = test.variants.map(variant => {
      const variantOutcomes = outcomes.filter(o => o.variantId === variant.id);
      const scores = variantOutcomes.map(o => o.score);
      const samples = scores.length;
      const meanScore = samples > 0 ? scores.reduce((a, b) => a + b, 0) / samples : 0;
      const stdDev = samples > 1 ? this.stdDev(scores) : 0;

      return {
        variantId: variant.id,
        label: variant.label,
        samples,
        meanScore,
        stdDev,
      };
    });

    // Determine winner (if any variant has clearly higher mean score)
    const sorted = [...variantResults].sort((a, b) => b.meanScore - a.meanScore);
    const winner = sorted.length > 0 && sorted[0].samples > 0 ? sorted[0].variantId : null;
    const confidence = winner ? this.calculateConfidence(testId) : 0;

    return {
      testId,
      variants: variantResults,
      winner,
      confidence,
    };
  }

  /**
   * Calculate statistical significance using Welch's t-test approximation.
   * Returns whether one variant is significantly better (p < 0.05).
   */
  getStatisticalSignificance(testId: string): SignificanceResult {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`A/B test '${testId}' not found. Use listTests() to see available tests.`);

    const results = this.getResults(testId);

    // Need at least 2 variants with data
    const withData = results.variants.filter(v => v.samples >= 2);
    if (withData.length < 2) {
      return {
        testId,
        significant: false,
        pValue: 1,
        confidence: 0,
        betterVariant: null,
        recommendation: 'insufficient-data',
        details: `Need at least 2 samples per variant. Currently: ${results.variants.map(v => `${v.label}=${v.samples}`).join(', ')}`,
      };
    }

    // Compare top 2 variants
    const sorted = [...withData].sort((a, b) => b.meanScore - a.meanScore);
    const top = sorted[0];
    const second = sorted[1];

    // Welch's t-test
    const tStat = (top.meanScore - second.meanScore) /
      Math.sqrt(
        (top.stdDev ** 2 / top.samples) +
        (second.stdDev ** 2 / second.samples)
      );

    // Welch-Satterthwaite degrees of freedom
    const num = (top.stdDev ** 2 / top.samples + second.stdDev ** 2 / second.samples) ** 2;
    const denom = ((top.stdDev ** 2 / top.samples) ** 2 / (top.samples - 1)) +
                  ((second.stdDev ** 2 / second.samples) ** 2 / (second.samples - 1));
    const df = denom > 0 ? num / denom : 1;

    // Approximate p-value from t-statistic (two-tailed)
    const pValue = this.tToPValue(Math.abs(tStat), df);
    const confidence = 1 - pValue;

    const significant = pValue < 0.05;
    const betterVariant = significant ? top.variantId : null;

    let recommendation: 'promote' | 'continue' | 'insufficient-data';
    if (significant && top.samples >= 10) {
      recommendation = 'promote';
    } else if (top.samples < 10) {
      recommendation = 'continue';
    } else {
      recommendation = 'continue';
    }

    return {
      testId,
      significant,
      pValue,
      confidence,
      betterVariant,
      recommendation,
      details: significant
        ? `Variant "${top.label}" is significantly better than "${second.label}" (p=${pValue.toFixed(4)}, t=${tStat.toFixed(3)}, df=${df.toFixed(1)})`
        : `No significant difference yet (p=${pValue.toFixed(4)}, t=${tStat.toFixed(3)}, df=${df.toFixed(1)})`,
    };
  }

  /**
   * Auto-promote winning variant if statistically significant.
   * Returns the winning variant or null.
   */
  promoteWinner(testId: string): PromptVariant | null {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`A/B test '${testId}' not found. Use listTests() to see available tests.`);

    const sig = this.getStatisticalSignificance(testId);

    if (sig.recommendation !== 'promote' || !sig.betterVariant) {
      this.logger.info(`[ABTesting] Test ${testId} not ready for promotion: ${sig.details}`);
      return null;
    }

    const winner = test.variants.find(v => v.id === sig.betterVariant);
    if (!winner) return null;

    // Mark test as completed
    test.status = 'completed';
    test.updatedAt = new Date().toISOString();

    // Move to history
    this.history.push({ ...test });
    this.tests.delete(testId);
    this.save();

    this.logger.info(`[ABTesting] Promoted variant "${winner.label}" for test "${test.name}" (confidence: ${(sig.confidence * 100).toFixed(1)}%)`);
    return winner;
  }

  /**
   * Get all active (running) tests.
   */
  getActiveTests(): ABTest[] {
    return Array.from(this.tests.values()).filter(t => t.status === 'running');
  }

  /**
   * Get test history (completed tests).
   */
  getTestHistory(): ABTest[] {
    return this.history;
  }

  /**
   * Get a specific test by ID.
   */
  getTest(testId: string): ABTest | undefined {
    return this.tests.get(testId);
  }

  /**
   * Pause a running test.
   */
  pauseTest(testId: string): void {
    const test = this.tests.get(testId);
    if (test) {
      test.status = 'paused';
      test.updatedAt = new Date().toISOString();
      this.save();
      this.logger.info(`[ABTesting] Paused test "${test.name}"`);
    }
  }

  /**
   * Resume a paused test.
   */
  resumeTest(testId: string): void {
    const test = this.tests.get(testId);
    if (test && test.status === 'paused') {
      test.status = 'running';
      test.updatedAt = new Date().toISOString();
      this.save();
      this.logger.info(`[ABTesting] Resumed test "${test.name}"`);
    }
  }

  // ─── Deterministic Scoring ──────────────────────────────────────────────────

  /**
   * Calculate a deterministic outcome score from response signals.
   * No LLM needed — uses observable metrics.
   *
   * Metrics:
   * - Response length appropriateness (not too short, not too long)
   * - Tool call efficiency (fewer calls = better, if task completed)
   * - Error rate (0 errors = best)
   * - User follow-up rate (lower = better — means response was sufficient)
   *
   * Returns 0-1 score.
   */
  static calculateScore(metrics: {
    responseLength: number;
    toolCallsMade: number;
    errors: number;
    userFollowedUp: boolean;
    taskCompleted: boolean;
  }): number {
    let score = 0;

    // Response length: ideal range 100-2000 chars
    const len = metrics.responseLength;
    if (len >= 100 && len <= 2000) {
      score += 0.3; // Ideal length
    } else if (len >= 50 && len <= 4000) {
      score += 0.2; // Acceptable
    } else if (len > 0) {
      score += 0.1; // Too short or too long
    }

    // Tool call efficiency: fewer is better when task is done
    if (metrics.taskCompleted) {
      if (metrics.toolCallsMade === 0) score += 0.25;
      else if (metrics.toolCallsMade <= 3) score += 0.2;
      else if (metrics.toolCallsMade <= 6) score += 0.1;
      // 7+ calls = diminishing returns
    }

    // Error rate: 0 errors = full marks
    if (metrics.errors === 0) score += 0.25;
    else if (metrics.errors <= 2) score += 0.1;
    // 3+ errors = penalty

    // User follow-up: no follow-up means response was sufficient
    if (!metrics.userFollowedUp) score += 0.2;
    else score += 0.05; // Follow-up suggests response was incomplete but not wrong

    return Math.min(1, score);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  private calculateConfidence(testId: string): number {
    // Inline variant stats to avoid circular call: getResults → calculateConfidence → getStatisticalSignificance → getResults
    const test = this.tests.get(testId);
    if (!test) return 0;
    const outcomes = this.outcomes.get(testId) || [];
    const withData = test.variants.map(variant => {
      const scores = outcomes.filter(o => o.variantId === variant.id).map(o => o.score);
      return { variantId: variant.id, label: variant.label, samples: scores.length, meanScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0, stdDev: scores.length > 1 ? this.stdDev(scores) : 0 };
    }).filter(v => v.samples >= 2);
    if (withData.length < 2) return 0;
    const sorted = [...withData].sort((a, b) => b.meanScore - a.meanScore);
    const top = sorted[0], second = sorted[1];
    const tStat = (top.meanScore - second.meanScore) / Math.sqrt((top.stdDev ** 2 / top.samples) + (second.stdDev ** 2 / second.samples));
    const num = (top.stdDev ** 2 / top.samples + second.stdDev ** 2 / second.samples) ** 2;
    const denom = ((top.stdDev ** 2 / top.samples) ** 2 / (top.samples - 1)) + ((second.stdDev ** 2 / second.samples) ** 2 / (second.samples - 1));
    const df = denom > 0 ? num / denom : 1;
    const pValue = this.tToPValue(Math.abs(tStat), df);
    return 1 - pValue;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Approximate p-value from t-statistic using a normal approximation.
   * This is a simplified two-tailed test — not exact but good enough for A/B decisions.
   *
   * For large df (>30), t-distribution ≈ normal distribution.
   * For small df, we use a simple correction.
   */
  private tToPValue(tStat: number, df: number): number {
    // For large df, use normal approximation
    if (df > 30) {
      // Normal CDF approximation
      return 2 * (1 - this.normalCDF(tStat));
    }

    // For small df, use a simple approximation:
    // p ≈ 2 * (1 - CDF_t(t, df))
    // Approximate t CDF using the incomplete beta function approximation
    const x = df / (df + tStat * tStat);
    const ib = this.incompleteBeta(x, df / 2, 0.5);
    return Math.min(1, ib);
  }

  private normalCDF(x: number): number {
    // Abramowitz & Stegun approximation
    const z = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return x >= 0 ? y : 1 - y;
  }

  private incompleteBeta(x: number, a: number, b: number): number {
    // Continued fraction expansion (Numerical Recipes approximation)
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    const lbeta = this.logGamma(a) + this.logGamma(b) - this.logGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

    // Use continued fraction
    const cf = this.betaCF(x, a, b);
    return front * cf;
  }

  private betaCF(x: number, a: number, b: number): number {
    const maxIter = 200;
    const epsilon = 1e-14;
    let qab = a + b;
    let qap = a + 1;
    let qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < epsilon) d = epsilon;
    d = 1 / d;
    let h = d;

    for (let m = 1; m <= maxIter; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < epsilon) d = epsilon;
      c = 1 + aa / c;
      if (Math.abs(c) < epsilon) c = epsilon;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < epsilon) d = epsilon;
      c = 1 + aa / c;
      if (Math.abs(c) < epsilon) c = epsilon;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < epsilon) break;
    }

    return h;
  }

  private logGamma(x: number): number {
    // Stirling's approximation for log gamma
    const cof = [
      76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let ser = 0.9999999999999971;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let xx = x;
    for (const c of cof) {
      xx += 1;
      ser += c / xx;
    }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
}
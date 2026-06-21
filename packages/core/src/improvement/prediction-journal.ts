/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Prediction Journal
 *
 * Log predictions before acting, then resolve them against actual outcomes.
 * Calculates calibration curves over time — how well does the agent's
 * confidence match reality?
 *
 * Inspired by Tetlock's superforecasting research: tracking predictions
 * and measuring calibration is how you get better at judging.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PredictionEntry {
  id: string;
  task: string;
  expectedOutcome: string;
  confidence: number; // 0-1
  deadline: string; // ISO timestamp
  createdAt: string;
  resolvedAt?: string;
  actualOutcome?: string;
  status: 'pending' | 'met' | 'missed' | 'expired';
  /** Tags for grouping/filtering */
  tags?: string[];
}

export interface CalibrationBucket {
  /** The confidence range (e.g. 0.6-0.7) */
  range: string;
  /** Number of predictions in this range */
  total: number;
  /** Number that came true */
  correct: number;
  /** Actual hit rate in this range */
  hitRate: number;
  /** Ideal hit rate (midpoint of range) */
  idealRate: number;
  /** Deviation from ideal */
  deviation: number;
}

export interface CalibrationReport {
  /** Overall Brier score (lower = better calibrated) */
  brierScore: number;
  /** Bucketed calibration curve */
  buckets: CalibrationBucket[];
  /** Total predictions resolved */
  totalPredictions: number;
  /** Overall accuracy */
  accuracy: number;
  /** Generated at */
  generatedAt: string;
}

// ─── Prediction Journal ─────────────────────────────────────────────────────

export class PredictionJournal {
  private predictions: Map<string, PredictionEntry> = new Map();
  private dbPath: string;
  private loaded = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Load predictions from disk */
  async init(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await readFile(this.dbPath, 'utf-8');
      const entries: PredictionEntry[] = JSON.parse(data);
      for (const entry of entries) {
        this.predictions.set(entry.id, entry);
      }
    } catch {
      // File doesn't exist yet — start empty
    }
    this.loaded = true;
  }

  // ─── Core Operations ────────────────────────────────────────────────

  /** Log a prediction before acting */
  async predict(
    task: string,
    expectedOutcome: string,
    confidence: number,
    deadline: string,
    tags?: string[],
  ): Promise<PredictionEntry> {
    await this.ensureInit();

    const id = `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const entry: PredictionEntry = {
      id,
      task,
      expectedOutcome,
      confidence: Math.max(0, Math.min(1, confidence)),
      deadline,
      createdAt: new Date().toISOString(),
      status: 'pending',
      tags,
    };

    this.predictions.set(id, entry);
    await this.persist();
    return entry;
  }

  /** Resolve a prediction with the actual outcome */
  async resolve(predictionId: string, actualOutcome: string): Promise<PredictionEntry> {
    await this.ensureInit();

    const entry = this.predictions.get(predictionId);
    if (!entry) {
      throw new Error(`Prediction '${predictionId}' not found. Use listPredictions() to see available predictions.`);
    }

    entry.actualOutcome = actualOutcome;
    entry.resolvedAt = new Date().toISOString();

    // Determine if the prediction was met or missed
    // Simple heuristic: check if the actual outcome matches the expected outcome
    entry.status = this.assessOutcome(entry.expectedOutcome, actualOutcome);

    await this.persist();
    return entry;
  }

  /** Mark expired predictions (past deadline, still pending) */
  async expireOverdue(): Promise<PredictionEntry[]> {
    await this.ensureInit();

    const now = new Date();
    const expired: PredictionEntry[] = [];

    for (const entry of this.predictions.values()) {
      if (entry.status !== 'pending') continue;
      const deadline = new Date(entry.deadline);
      if (deadline < now) {
        entry.status = 'expired';
        entry.resolvedAt = new Date().toISOString();
        entry.actualOutcome = 'No resolution before deadline';
        expired.push(entry);
      }
    }

    if (expired.length > 0) {
      await this.persist();
    }
    return expired;
  }

  // ─── Calibration ────────────────────────────────────────────────────

  /** Calculate calibration curve and accuracy metrics */
  async calibrate(): Promise<CalibrationReport> {
    await this.ensureInit();

    const resolved = Array.from(this.predictions.values())
      .filter(p => p.status === 'met' || p.status === 'missed');

    if (resolved.length === 0) {
      return {
        brierScore: 0,
        buckets: [],
        totalPredictions: 0,
        accuracy: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    // Calculate Brier score
    let brierSum = 0;
    let correctCount = 0;

    for (const p of resolved) {
      const outcome = p.status === 'met' ? 1 : 0;
      const diff = p.confidence - outcome;
      brierSum += diff * diff;
      if (p.status === 'met') correctCount++;
    }

    const brierScore = brierSum / resolved.length;
    const accuracy = correctCount / resolved.length;

    // Bucket into 10% ranges for calibration curve
    const bucketRanges = [
      [0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5],
      [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0],
    ];

    const buckets: CalibrationBucket[] = bucketRanges.map(([lo, hi]) => {
      const inRange = resolved.filter(p => p.confidence >= lo && p.confidence < hi);
      const correct = inRange.filter(p => p.status === 'met').length;
      const total = inRange.length;
      const hitRate = total > 0 ? correct / total : 0;
      const idealRate = (lo + hi) / 2;

      return {
        range: `${lo.toFixed(1)}-${hi.toFixed(1)}`,
        total,
        correct,
        hitRate,
        idealRate,
        deviation: total > 0 ? Math.abs(hitRate - idealRate) : 0,
      };
    });

    return {
      brierScore,
      buckets,
      totalPredictions: resolved.length,
      accuracy,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── Query ──────────────────────────────────────────────────────────

  /** Get a specific prediction */
  async get(predictionId: string): Promise<PredictionEntry | null> {
    await this.ensureInit();
    return this.predictions.get(predictionId) ?? null;
  }

  /** List predictions, optionally filtered */
  async list(options?: {
    status?: PredictionEntry['status'];
    tags?: string[];
    limit?: number;
  }): Promise<PredictionEntry[]> {
    await this.ensureInit();

    let entries = Array.from(this.predictions.values());

    if (options?.status) {
      entries = entries.filter(p => p.status === options.status);
    }

    if (options?.tags?.length) {
      entries = entries.filter(p =>
        options.tags!.some(t => p.tags?.includes(t)),
      );
    }

    // Sort by creation date, newest first
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return options?.limit ? entries.slice(0, options.limit) : entries;
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  /**
   * Assess whether an actual outcome matches the expected outcome.
   * Uses a simple heuristic: keyword overlap > 50% means met.
   * In production, this would use semantic similarity.
   */
  private assessOutcome(expected: string, actual: string): 'met' | 'missed' {
    const expectedWords = new Set(expected.toLowerCase().split(/\s+/));
    const actualWords = new Set(actual.toLowerCase().split(/\s+/));

    // Remove common stop words
    const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on',
      'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before',
      'after', 'above', 'below', 'between', 'out', 'off', 'over', 'under', 'again',
      'further', 'then', 'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
      'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
      'too', 'very', 'just', 'because']);

    for (const sw of stopWords) {
      expectedWords.delete(sw);
      actualWords.delete(sw);
    }

    if (expectedWords.size === 0) return 'missed';

    let overlap = 0;
    for (const word of expectedWords) {
      if (actualWords.has(word)) overlap++;
    }

    return (overlap / expectedWords.size) >= 0.5 ? 'met' : 'missed';
  }

  private async persist(): Promise<void> {
    const entries = Array.from(this.predictions.values());
    const json = JSON.stringify(entries, null, 2);

    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, json, 'utf-8');
  }
}
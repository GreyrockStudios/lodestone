/**
 * Lodestone Calibration Loop
 *
 * The feedback loop that closes the prediction → verification → calibration cycle.
 * Runs periodically to:
 * 1. Auto-expire overdue predictions
 * 2. Compute calibration metrics
 * 3. Adjust future confidence based on past accuracy
 * 4. Generate calibration insights for the agent
 *
 * No LLM — all deterministic.
 */

import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { PredictionJournal, type PredictionEntry, type CalibrationReport } from './prediction-journal.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CalibrationLoopConfig {
  /** Data directory */
  dataDir: string;
  /** Prediction journal instance (shared with ImprovementSystem) */
  journal: PredictionJournal;
  /** How often to run the loop (ms, default: 1 hour) */
  intervalMs?: number;
  /** Confidence adjustment strength (0-1, default: 0.1)
   * Higher = faster adaptation, lower = more stable */
  adjustmentStrength?: number;
}

export interface CalibrationInsight {
  type: 'overconfident' | 'underconfident' | 'well-calibrated' | 'insufficient-data';
  area: string;
  message: string;
  adjustment: number; // -0.2 to +0.2
  sampleSize: number;
}

export interface CalibrationLoopResult {
  expiredCount: number;
  resolvedCount: number;
  report: CalibrationReport | null;
  insights: CalibrationInsight[];
  timestamp: string;
}

// ─── Calibration Loop ────────────────────────────────────────────────────────

export class CalibrationLoop {
  private config: Required<CalibrationLoopConfig>;
  private adjustments: Map<string, number> = new Map(); // area → confidence adjustment
  private lastRun: string | null = null;

  constructor(config: CalibrationLoopConfig) {
    this.config = {
      dataDir: config.dataDir,
      journal: config.journal,
      intervalMs: config.intervalMs || 60 * 60 * 1000,
      adjustmentStrength: config.adjustmentStrength ?? 0.1,
    };

    try { mkdirSync(this.config.dataDir, { recursive: true }); } catch { /* exists */ }
  }

  async init(): Promise<void> {
    const adjPath = join(this.config.dataDir, 'confidence-adjustments.json');
    if (existsSync(adjPath)) {
      try {
        const data = JSON.parse(readFileSync(adjPath, 'utf-8'));
        this.adjustments = new Map(Object.entries(data));
      } catch { /* start fresh */ }
    }
  }

  /** Run the calibration loop */
  async run(): Promise<CalibrationLoopResult> {
    const timestamp = new Date().toISOString();
    this.lastRun = timestamp;

    // 1. Expire overdue predictions
    const expired = await this.config.journal.expireOverdue();

    // 2. Compute calibration
    const report = await this.config.journal.calibrate();

    // 3. Generate insights and adjust confidence
    const insights = this.generateInsights(report);

    // 4. Persist adjustments
    this.saveAdjustments();

    return {
      expiredCount: expired.length,
      resolvedCount: report.totalPredictions,
      report,
      insights,
      timestamp,
    };
  }

  /** Generate calibration insights based on accuracy data */
  private generateInsights(report: CalibrationReport): CalibrationInsight[] {
    const insights: CalibrationInsight[] = [];

    if (report.totalPredictions < 10) {
      insights.push({
        type: 'insufficient-data',
        area: 'general',
        message: `Only ${report.totalPredictions} resolved predictions. Need 10+ for meaningful calibration.`,
        adjustment: 0,
        sampleSize: report.totalPredictions,
      });
      return insights;
    }

    // Check Brier score (0 = perfect, 1 = worst)
    if (report.brierScore < 0.1) {
      insights.push({
        type: 'well-calibrated',
        area: 'general',
        message: `Excellent calibration (Brier ${report.brierScore.toFixed(3)}). Predictions are reliable.`,
        adjustment: 0,
        sampleSize: report.totalPredictions,
      });
    } else if (report.brierScore > 0.3) {
      const adjustment = -this.config.adjustmentStrength * Math.min(report.brierScore, 0.5);
      this.adjustments.set('general', adjustment);
      insights.push({
        type: 'overconfident',
        area: 'general',
        message: `Overconfident (Brier ${report.brierScore.toFixed(3)}). Reducing confidence by ${Math.abs(adjustment).toFixed(3)} for future predictions.`,
        adjustment,
        sampleSize: report.totalPredictions,
      });
    } else if (report.brierScore < 0.05 && report.totalPredictions > 20) {
      const adjustment = this.config.adjustmentStrength * 0.5;
      this.adjustments.set('general', adjustment);
      insights.push({
        type: 'underconfident',
        area: 'general',
        message: `Underconfident (Brier ${report.brierScore.toFixed(3)}). Slightly increasing confidence by ${adjustment.toFixed(3)}.`,
        adjustment,
        sampleSize: report.totalPredictions,
      });
    }

    for (const bucket of report.buckets) {
      if (bucket.total < 5) continue;

      const expectedRate = bucket.idealRate;
      const actualRate = bucket.hitRate;
      const gap = actualRate - expectedRate;
      const rangeParts = bucket.range.split('-');
      const low = parseFloat(rangeParts[0]) || 0;
      const high = parseFloat(rangeParts[1]) || 1;

      if (gap > 0.15) {
        const adjustment = this.config.adjustmentStrength * 0.5;
        this.adjustments.set(`bucket-${low}-${high}`, adjustment);
        insights.push({
          type: 'underconfident',
          area: `confidence ${Math.round(low * 100)}-${Math.round(high * 100)}%`,
          message: `When you say ${Math.round(expectedRate * 100)}% confident, you're actually ${Math.round(actualRate * 100)}% correct. Underconfident.`,
          adjustment,
          sampleSize: bucket.total,
        });
      } else if (gap < -0.15) {
        const adjustment = -this.config.adjustmentStrength;
        this.adjustments.set(`bucket-${low}-${high}`, adjustment);
        insights.push({
        type: 'overconfident',
          area: `confidence ${Math.round(low * 100)}-${Math.round(high * 100)}%`,
          message: `When you say ${Math.round(expectedRate * 100)}% confident, you're only ${Math.round(actualRate * 100)}% correct. Overconfident.`,
          adjustment,
          sampleSize: bucket.total,
        });
      }
    }

    return insights;
  }

  /** Get the confidence adjustment for a given confidence level */
  getAdjustment(confidence: number): number {
    // Find the relevant bucket adjustment
    let bestAdjustment = this.adjustments.get('general') || 0;
    for (const [key, adj] of this.adjustments) {
      if (key.startsWith('bucket-')) {
        const [low, high] = key.replace('bucket-', '').split('-').map(Number);
        if (confidence >= low && confidence < high) {
          bestAdjustment += adj; // Combine general + bucket-specific
          break;
        }
      }
    }
    // Clamp: confidence adjustment should be -0.2 to +0.2
    return Math.max(-0.2, Math.min(0.2, bestAdjustment));
  }

  /** Apply confidence adjustment to a raw confidence value */
  adjustConfidence(rawConfidence: number): number {
    const adjustment = this.getAdjustment(rawConfidence);
    return Math.max(0, Math.min(1, rawConfidence + adjustment));
  }

  /** Get current adjustments for dashboard */
  getAdjustments(): { area: string; adjustment: number }[] {
    return Array.from(this.adjustments.entries()).map(([area, adjustment]) => ({ area, adjustment }));
  }

  private saveAdjustments(): void {
    const data = Object.fromEntries(this.adjustments);
    writeFileSync(join(this.config.dataDir, 'confidence-adjustments.json'), JSON.stringify(data, null, 2));
  }
}
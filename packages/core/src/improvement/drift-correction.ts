/**
 * Lodestone Drift Correction
 *
 * Extends the drift detector with active course correction.
 * When drift is detected, it generates corrective prompt injections
 * that steer the agent back toward its core principles.
 *
 * No LLM — all deterministic rule-based corrections.
 */

import { DriftDetector, type DriftReport, type IdentityRule } from './drift-detector.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriftCorrectionConfig {
  /** Data directory */
  dataDir: string;
  /** Drift detector instance (shared with ImprovementSystem) */
  detector: DriftDetector;
  /** Core principles / identity rules to enforce */
  principles: Principle[];
  /** Drift threshold for triggering correction (default: 0.3) */
  correctionThreshold?: number;
  /** Cooldown between corrections in ms (default: 24 hours) */
  cooldownMs?: number;
}

export interface Principle {
  id: string;
  name: string;
  description: string;
  expectedBehavior: string;
  violationExamples: string[];
  correctionPrompt: string;
}

export interface DriftCorrection {
  id: string;
  principleId: string;
  principleName: string;
  driftScore: number;
  severity: 'minor' | 'moderate' | 'severe';
  correctionPrompt: string;
  detectedAt: string;
  appliedAt: string | null;
  status: 'pending' | 'applied' | 'dismissed';
}

export interface DriftCorrectionResult {
  corrections: DriftCorrection[];
  overallDrift: number;
  recommendation: string;
  timestamp: string;
}

// ─── Drift Corrector ────────────────────────────────────────────────────────

export class DriftCorrector {
  private config: Required<DriftCorrectionConfig>;
  private corrections: DriftCorrection[] = [];
  private lastCorrectionTime: number = 0;

  constructor(config: DriftCorrectionConfig) {
    this.config = {
      dataDir: config.dataDir,
      detector: config.detector,
      principles: config.principles,
      correctionThreshold: config.correctionThreshold ?? 0.3,
      cooldownMs: config.cooldownMs ?? 24 * 60 * 60 * 1000,
    };

    try { mkdirSync(this.config.dataDir, { recursive: true }); } catch { /* exists */ }
  }

  async init(): Promise<void> {
    const path = join(this.config.dataDir, 'drift-corrections.json');
    if (existsSync(path)) {
      try {
        this.corrections = JSON.parse(readFileSync(path, 'utf-8'));
      } catch { /* fresh */ }
    }
  }

  /** Run drift detection and generate corrections */
  async checkAndCorrect(): Promise<DriftCorrectionResult> {
    const timestamp = new Date().toISOString();
    // DriftDetector.check() requires recentDecisions — pass empty for now
    const report = await this.config.detector.check([], []);
    const corrections: DriftCorrection[] = [];

    // Check each principle for drift
    for (const principle of this.config.principles) {
      const driftScore = this.assessPrincipleDrift(report, principle);

      if (driftScore >= this.config.correctionThreshold) {
        // Check cooldown
        const now = Date.now();
        const recentCorrection = this.corrections
          .filter(c => c.principleId === principle.id)
          .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0];
        if (recentCorrection && now - new Date(recentCorrection.detectedAt).getTime() < this.config.cooldownMs) {
          continue; // Still in cooldown
        }

        const severity = driftScore >= 0.6 ? 'severe' : driftScore >= 0.4 ? 'moderate' : 'minor';

        const correction: DriftCorrection = {
          id: `drift-corr-${Date.now()}-${principle.id}`,
          principleId: principle.id,
          principleName: principle.name,
          driftScore,
          severity,
          correctionPrompt: principle.correctionPrompt,
          detectedAt: timestamp,
          appliedAt: null,
          status: 'pending',
        };

        corrections.push(correction);
        this.corrections.push(correction);
      }
    }

    // Persist
    if (corrections.length > 0) {
      this.saveCorrections();
    }

    // Generate overall recommendation
    const overallDrift = corrections.length > 0
      ? corrections.reduce((sum, c) => sum + c.driftScore, 0) / corrections.length
      : 0;

    const recommendation = this.generateRecommendation(overallDrift, corrections);

    return { corrections, overallDrift, recommendation, timestamp };
  }

  /** Assess how much a specific principle has drifted */
  private assessPrincipleDrift(report: DriftReport, principle: Principle): number {
    // Match principle to drift report rules
    const matchedRules = report.scores.filter(score =>
      score.rule.toLowerCase().includes(principle.name.toLowerCase()) ||
      score.category.toLowerCase().includes(principle.id.toLowerCase())
    );

    if (matchedRules.length === 0) return 0;

    // Average drift score across matched rules
    const avgScore = matchedRules.reduce((sum, r) => sum + r.drift, 0) / matchedRules.length;

    // Check for violation patterns in relevant decisions
    let violationHits = 0;
    for (const score of matchedRules) {
      for (const example of principle.violationExamples) {
        if (score.relevantDecisions.some(d => d.toLowerCase().includes(example.toLowerCase()))) {
          violationHits++;
        }
      }
    }

    // Add penalty for violations
    return Math.min(1, avgScore + (violationHits * 0.1));
  }

  /** Generate a human-readable recommendation */
  private generateRecommendation(overallDrift: number, corrections: DriftCorrection[]): string {
    if (corrections.length === 0) {
      return 'No significant drift detected. Behavior aligns with core principles.';
    }

    if (overallDrift >= 0.6) {
      return `⚠️ SEVERE DRIFT DETECTED. ${corrections.length} principles need correction. ` +
        `Immediate action required. Injecting corrective prompts into next response.`;
    } else if (overallDrift >= 0.4) {
      return `⚠️ Moderate drift detected in ${corrections.length} areas. ` +
        `Corrective prompts will be injected to steer behavior back.`;
    } else {
      return `Minor drift detected in ${corrections.length} areas. ` +
        `Logging for awareness — no immediate correction needed.`;
    }
  }

  /** Get pending corrections that should be injected into the next prompt */
  getPendingCorrections(): DriftCorrection[] {
    return this.corrections.filter(c => c.status === 'pending');
  }

  /** Mark a correction as applied (injected into prompt) */
  markApplied(correctionId: string): void {
    const correction = this.corrections.find(c => c.id === correctionId);
    if (correction) {
      correction.appliedAt = new Date().toISOString();
      correction.status = 'applied';
      this.saveCorrections();
    }
  }

  /** Dismiss a correction (user disagreed) */
  dismiss(correctionId: string): void {
    const correction = this.corrections.find(c => c.id === correctionId);
    if (correction) {
      correction.status = 'dismissed';
      this.saveCorrections();
    }
  }

  /** Format corrections for prompt injection */
  formatForPrompt(corrections: DriftCorrection[]): string {
    if (corrections.length === 0) return '';

    const lines: string[] = ['## ⚠️ Drift Correction — Course Adjustment Required\n'];
    lines.push('Your recent behavior has drifted from core principles. Please adjust:\n');

    for (const c of corrections) {
      lines.push(`### ${c.principleName} (drift score: ${c.driftScore.toFixed(2)}, severity: ${c.severity})`);
      lines.push(c.correctionPrompt);
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Get stats for dashboard */
  getStats(): { totalCorrections: number; pending: number; applied: number; dismissed: number; avgDrift: number } {
    const pending = this.corrections.filter(c => c.status === 'pending').length;
    const applied = this.corrections.filter(c => c.status === 'applied').length;
    const dismissed = this.corrections.filter(c => c.status === 'dismissed').length;
    const avgDrift = this.corrections.length > 0
      ? this.corrections.reduce((s, c) => s + c.driftScore, 0) / this.corrections.length
      : 0;

    return { totalCorrections: this.corrections.length, pending, applied, dismissed, avgDrift };
  }

  private saveCorrections(): void {
    // Keep only last 200
    if (this.corrections.length > 200) {
      this.corrections = this.corrections.slice(-200);
    }
    writeFileSync(join(this.config.dataDir, 'drift-corrections.json'), JSON.stringify(this.corrections, null, 2));
  }
}

// ─── Default Principles ─────────────────────────────────────────────────────

export const DEFAULT_PRINCIPLES: Principle[] = [
  {
    id: 'truthfulness',
    name: 'Truthfulness',
    description: 'Always tell the truth. Never fabricate facts, URLs, or outcomes.',
    expectedBehavior: 'Responses are factual and verifiable.',
    violationExamples: ['hallucinated', 'fabricated', 'made up'],
    correctionPrompt: 'You have been making claims that may not be factual. Before making any claim, verify it against known sources. If you are unsure, say so explicitly.',
  },
  {
    id: 'proactive',
    name: 'Proactive',
    description: 'Take initiative. Don\'t wait to be asked.',
    expectedBehavior: 'Agent identifies opportunities and acts on them.',
    violationExamples: ['waited for instruction', 'did not act', 'passive'],
    correctionPrompt: 'You have been too passive. Look for opportunities to add value without being asked. Check the heartbeat, scan for issues, suggest improvements.',
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Be direct. Skip the fluff.',
    expectedBehavior: 'Responses are concise and to the point.',
    violationExamples: ['verbose', 'repetitive', 'too long'],
    correctionPrompt: 'Your recent responses have been verbose. Be more concise. Lead with the key point, then add detail only if necessary.',
  },
  {
    id: 'safety-first',
    name: 'Safety First',
    description: 'Never run dangerous commands or expose secrets.',
    expectedBehavior: 'All tool calls are safe and approved.',
    violationExamples: ['rm -rf', 'exposed key', 'unapproved action'],
    correctionPrompt: 'You have been taking actions that bypass safety checks. Always check capability tiers before executing tools. Never output secrets.',
  },
];
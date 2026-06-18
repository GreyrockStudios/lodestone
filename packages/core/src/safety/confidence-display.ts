/**
 * Lodestone — Confidence Transparency
 *
 * Every response includes a calibrated confidence score based on
 * historical accuracy. The score is deterministic — no LLM involved.
 *
 * Scoring factors:
 * 1. Response specificity (generic vs specific language)
 * 2. Source citation (references to stored memories or tool outputs)
 * 3. Verification status (did truth-binding guards pass?)
 * 4. Historical calibration (Brier score from CalibrationLoop)
 * 5. Ambiguity markers (hedging language count)
 *
 * Score bands:
 *   80-100  "high"
 *   60-79   "moderate"
 *   40-59   "low"
 *   0-39    "very low"
 */

import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfidenceContext {
  /** Did truth-binding guards pass? (from TruthBinding result) */
  truthGuardsPassed: boolean;
  /** Were there any blocking guards? */
  truthGuardsBlocked: boolean;
  /** Number of warning-level guards */
  truthWarningCount: number;
  /** Did the response cite stored memories or wiki pages? */
  hasSourceCitations: boolean;
  /** Were tool calls made to verify claims? */
  hasToolVerification: boolean;
  /** Response type for calibration lookup */
  responseType: 'question' | 'task' | 'monitoring' | 'follow-up' | 'correction' | 'proactive' | 'social' | 'ambiguous';
  /** Brier score from CalibrationLoop (optional, 0 = perfect, 1 = worst) */
  brierScore?: number;
  /** Confidence adjustment from CalibrationLoop (optional, -0.2 to +0.2) */
  calibrationAdjustment?: number;
}

export interface ConfidenceScore {
  /** Raw score 0-100 */
  score: number;
  /** Adjusted score after calibration (0-100) */
  adjustedScore: number;
  /** Band label */
  band: 'high' | 'moderate' | 'low' | 'very-low';
  /** Human-readable label */
  label: string;
  /** Breakdown of scoring factors */
  factors: ConfidenceFactors;
  /** Whether calibration was applied */
  calibrated: boolean;
}

export interface ConfidenceFactors {
  /** Specificity score (0-100): exact numbers and details vs vague language */
  specificity: number;
  /** Source citation score (0-100): references to stored data */
  sourceCitation: number;
  /** Verification score (0-100): truth-binding + tool verification */
  verification: number;
  /** Historical calibration score (0-100): based on Brier score */
  historicalCalibration: number;
  /** Ambiguity penalty (0-100): hedging language reduces confidence */
  ambiguityPenalty: number;
}

export interface CalibrationData {
  /** The response that was scored */
  response: string;
  /** The confidence score given */
  score: number;
  /** Whether the response was actually correct (learned later) */
  correct?: boolean;
  /** Timestamp */
  timestamp: string;
  /** Response type */
  responseType: string;
}

// ─── Scoring Patterns ─────────────────────────────────────────────────────

// Hedging / ambiguity markers (reduce confidence)
const HEDGING_PATTERNS: RegExp[] = [
  /\b(?:I think|I believe|probably|likely|maybe|perhaps|might be|could be|seems like|appears to)\b/gi,
  /\b(?:roughly|approximately|around|about|somewhere|or so|ish)\b/gi,
  /\b(?:not sure|uncertain|unclear|hard to say|difficult to say)\b/gi,
  /\b(?:guess|guessing|assume|assuming|suppose|supposed)\b/gi,
  /\b(?:seems|appears|looks like|sounds like)\b/gi,
];

// Specificity markers (increase confidence)
const SPECIFICITY_PATTERNS: RegExp[] = [
  // Exact numbers
  /\b\d+(?:\.\d+)?\s*(?:ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|%|percent|dollars?|\$|euros?|pounds?|users?|requests?|items?|files?|lines?|rows?|records?|entries?|nodes?|edges?)\b/gi,
  // Exact dates
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // Exact times
  /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi,
  // Version numbers
  /\bv?\d+\.\d+\.\d+\b/g,
  // File paths
  /\b(?:\/[\w.-]+)+\b/g,
  // URLs
  /https?:\/\/[^\s)}\]"']+/gi,
  // Named entities (Capitalized multi-word)
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
];

// Source citation markers
const CITATION_PATTERNS: RegExp[] = [
  /\[\[[\w-]+\]\]/gi,              // Wiki links [[slug]]
  /\b(?:wiki|documentation|docs?)\b/gi,  // Wiki references
  /\b(?:memory|memories|recall|stored)\b/gi,  // Memory references
  /\b(?:tool|function|api)\s+(?:result|output|returned|found)\b/gi,  // Tool output references
  /\b(?:according to|based on|from the|per the)\b/gi,  // Attribution phrases
  /\b(?:wiki page|knowledge base|previous(?:ly)?)\b/gi,  // Knowledge references
];

// ─── Confidence Display System ─────────────────────────────────────────────────

export class ConfidenceDisplay {
  private log = getLogger('confidence-display');
  private calibrationHistory: CalibrationData[] = [];
  private maxHistory: number;

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory;
  }

  /**
   * Calculate a confidence score for a response.
   * Pure deterministic scoring — no LLM.
   */
  calculateConfidence(response: string, context: ConfidenceContext): ConfidenceScore {
    // Factor 1: Specificity
    const specificity = this.scoreSpecificity(response);

    // Factor 2: Source citation
    const sourceCitation = this.scoreSourceCitation(response, context);

    // Factor 3: Verification
    const verification = this.scoreVerification(context);

    // Factor 4: Historical calibration
    const historicalCalibration = this.scoreHistoricalCalibration(context);

    // Factor 5: Ambiguity penalty
    const ambiguityPenalty = this.scoreAmbiguity(response);

    // Weighted sum
    const rawScore = Math.round(
      specificity * 0.25 +
      sourceCitation * 0.20 +
      verification * 0.25 +
      historicalCalibration * 0.15 +
      (100 - ambiguityPenalty) * 0.15
    );

    // Apply calibration adjustment
    let adjustedScore = rawScore;
    if (context.calibrationAdjustment !== undefined) {
      adjustedScore = Math.round(rawScore + context.calibrationAdjustment * 100);
    }

    // Clamp to 0-100
    adjustedScore = Math.max(0, Math.min(100, adjustedScore));

    const band = this.getBand(adjustedScore);
    const label = this.formatBandLabel(band, context.calibrationAdjustment !== undefined);

    const score: ConfidenceScore = {
      score: rawScore,
      adjustedScore,
      band,
      label,
      factors: {
        specificity,
        sourceCitation,
        verification,
        historicalCalibration,
        ambiguityPenalty,
      },
      calibrated: context.calibrationAdjustment !== undefined,
    };

    this.log.debug('Confidence calculated', {
      score: rawScore,
      adjusted: adjustedScore,
      band,
      responseType: context.responseType,
    });

    return score;
  }

  /**
   * Format a confidence score for display.
   */
  formatForDisplay(score: ConfidenceScore): string {
    const pct = score.adjustedScore;
    const bandLabel = score.band;

    if (bandLabel === 'high') {
      return `High confidence (${pct}%)${score.calibrated ? ' (calibrated)' : ''}`;
    } else if (bandLabel === 'moderate') {
      return `Moderate confidence (${pct}%)${score.calibrated ? ' (calibrated)' : ''}`;
    } else if (bandLabel === 'low') {
      return `Low confidence (${pct}%) — this is an estimate`;
    } else {
      return `Very low confidence (${pct}%) — verify before relying on this`;
    }
  }

  /**
   * Record a calibration data point (for future calibration analysis).
   */
  recordCalibration(data: CalibrationData): void {
    this.calibrationHistory.push(data);
    if (this.calibrationHistory.length > this.maxHistory) {
      this.calibrationHistory = this.calibrationHistory.slice(-this.maxHistory);
    }
  }

  /**
   * Get calibration history.
   */
  getCalibrationHistory(): CalibrationData[] {
    return [...this.calibrationHistory];
  }

  /**
   * Get calibration accuracy: percentage of responses where
   * confidence matched actual correctness.
   */
  getCalibrationAccuracy(): { total: number; correct: number; accuracy: number } {
    const verified = this.calibrationHistory.filter(c => c.correct !== undefined);
    const total = verified.length;
    if (total === 0) return { total: 0, correct: 0, accuracy: 0 };

    // A calibration is "correct" if high confidence (>=60) and actually correct,
    // or low confidence (<60) and actually incorrect
    const correct = verified.filter(c => {
      const highConf = c.score >= 60;
      return (highConf && c.correct) || (!highConf && !c.correct);
    }).length;

    return { total, correct, accuracy: correct / total };
  }

  // ─── Scoring Helpers ──────────────────────────────────────────────────────

  /**
   * Score specificity: exact numbers, dates, paths, named entities.
   */
  private scoreSpecificity(response: string): number {
    let matchCount = 0;
    for (const pattern of SPECIFICITY_PATTERNS) {
      const matches = response.match(pattern);
      if (matches) matchCount += matches.length;
    }

    // 0 matches = 30 (generic), 1-3 = 55, 4-6 = 75, 7+ = 95
    if (matchCount === 0) return 30;
    if (matchCount <= 3) return 55;
    if (matchCount <= 6) return 75;
    return 95;
  }

  /**
   * Score source citation: references to wiki, memory, tool outputs.
   */
  private scoreSourceCitation(response: string, context: ConfidenceContext): number {
    let score = 20; // Base score

    // Check for citation patterns in response
    for (const pattern of CITATION_PATTERNS) {
      if (pattern.test(response)) {
        score += 20;
        break; // Only count once
      }
    }

    // Boost if context indicates source citations
    if (context.hasSourceCitations) {
      score += 30;
    }

    // Boost if tool verification was done
    if (context.hasToolVerification) {
      score += 20;
    }

    return Math.min(100, score);
  }

  /**
   * Score verification: truth-binding guards and tool verification.
   */
  private scoreVerification(context: ConfidenceContext): number {
    let score = 50; // Base: unknown verification

    if (context.truthGuardsBlocked) {
      // Blocked = very low confidence
      return 10;
    }

    if (context.truthGuardsPassed) {
      score = 80;
      // Deduct for warnings
      score -= context.truthWarningCount * 5;
    } else if (context.truthWarningCount > 0) {
      score = 40;
      score -= context.truthWarningCount * 5;
    }

    // Boost for tool verification
    if (context.hasToolVerification) {
      score = Math.min(100, score + 15);
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Score historical calibration based on Brier score.
   */
  private scoreHistoricalCalibration(context: ConfidenceContext): number {
    if (context.brierScore === undefined) {
      return 50; // No data = neutral
    }

    // Brier score: 0 = perfect, 1 = worst
    // Convert to 0-100 scale (inverted)
    const score = Math.round((1 - context.brierScore) * 100);
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Score ambiguity: hedging language penalty (0-100, higher = more ambiguous).
   */
  private scoreAmbiguity(response: string): number {
    let hedgeCount = 0;
    for (const pattern of HEDGING_PATTERNS) {
      const matches = response.match(pattern);
      if (matches) hedgeCount += matches.length;
    }

    // 0 hedges = 0 (no ambiguity), 1-2 = 20, 3-4 = 40, 5+ = 60
    if (hedgeCount === 0) return 0;
    if (hedgeCount <= 2) return 20;
    if (hedgeCount <= 4) return 40;
    return 60;
  }

  /**
   * Get the confidence band from a score.
   */
  private getBand(score: number): ConfidenceScore['band'] {
    if (score >= 80) return 'high';
    if (score >= 60) return 'moderate';
    if (score >= 40) return 'low';
    return 'very-low';
  }

  /**
   * Format a band label.
   */
  private formatBandLabel(band: ConfidenceScore['band'], calibrated: boolean): string {
    const calTag = calibrated ? ' (calibrated)' : '';
    switch (band) {
      case 'high': return `High confidence${calTag}`;
      case 'moderate': return `Moderate confidence${calTag}`;
      case 'low': return `Low confidence — this is an estimate`;
      case 'very-low': return `Very low confidence — verify before relying on this`;
    }
  }
}
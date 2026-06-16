/**
 * Lodestone — Drift Detector
 *
 * Compares recent behavior against core principles from RULES.md.
 * Detects when the agent has drifted away from its stated values
 * and provides a structured report with suggestions for correction.
 *
 * Like a compass: you set your heading, and drift detection tells you
 * when you've gone off course.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IdentityRule {
  /** Short name for the principle */
  name: string;
  /** The rule statement */
  statement: string;
  /** Category of the rule (e.g., 'safety', 'quality', 'communication') */
  category: string;
  /** How important this rule is (0-1) */
  weight: number;
}

export interface DecisionRecord {
  /** What was decided */
  decision: string;
  /** Why it was decided (rationale) */
  rationale: string;
  /** When it was decided */
  timestamp: string;
  /** Tags for categorization */
  tags?: string[];
}

export interface DriftScore {
  /** The rule being scored */
  rule: string;
  /** Category of the rule */
  category: string;
  /** Drift score 0-1 (0 = no drift, 1 = maximum drift) */
  drift: number;
  /** Which recent decisions relate to this rule */
  relevantDecisions: string[];
  /** Why this drift was detected */
  reasoning: string;
  /** Suggestion for correction */
  suggestion: string;
}

export interface DriftReport {
  /** Overall drift score (0-1) */
  overallDrift: number;
  /** Per-principle scores */
  scores: DriftScore[];
  /** Flagged deviations (drift > threshold) */
  flagged: DriftScore[];
  /** Top suggestions for correction */
  suggestions: string[];
  /** Generated at */
  generatedAt: string;
  /** The identity rules used for comparison */
  rulesCount: number;
  /** The decisions analyzed */
  decisionsCount: number;
}

// ─── Drift Detector ─────────────────────────────────────────────────────────

export class DriftDetector {
  private reports: DriftReport[] = [];
  private dbPath: string;
  private loaded = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Load drift reports from disk */
  async init(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await readFile(this.dbPath, 'utf-8');
      this.reports = JSON.parse(data);
    } catch {
      this.reports = [];
    }
    this.loaded = true;
  }

  // ─── Core Operation ─────────────────────────────────────────────────

  /**
   * Compare recent decisions against identity rules.
   * Returns a drift report with scores, flagged deviations, and suggestions.
   */
  async check(
    identityRules: IdentityRule[],
    recentDecisions: DecisionRecord[],
  ): Promise<DriftReport> {
    await this.ensureInit();

    const scores: DriftScore[] = [];
    const driftThreshold = 0.5;

    // Score each identity rule against recent decisions
    for (const rule of identityRules) {
      const score = this.scoreRule(rule, recentDecisions);
      scores.push(score);
    }

    // Calculate overall drift
    const totalWeight = identityRules.reduce((sum, r) => sum + r.weight, 0);
    const overallDrift = totalWeight > 0
      ? scores.reduce((sum, s) => {
          const rule = identityRules.find(r => r.name === s.rule);
          const weight = rule?.weight ?? 0.5;
          return sum + (s.drift * weight);
        }, 0) / totalWeight
      : 0;

    // Flag deviations above threshold
    const flagged = scores.filter(s => s.drift > driftThreshold);

    // Generate suggestions from flagged items
    const suggestions = flagged
      .sort((a, b) => b.drift - a.drift)
      .slice(0, 5)
      .map(f => f.suggestion);

    const report: DriftReport = {
      overallDrift,
      scores,
      flagged,
      suggestions,
      generatedAt: new Date().toISOString(),
      rulesCount: identityRules.length,
      decisionsCount: recentDecisions.length,
    };

    this.reports.push(report);
    await this.persist();
    return report;
  }

  /** Get the most recent drift report */
  async getLatest(): Promise<DriftReport | null> {
    await this.ensureInit();
    return this.reports.length > 0 ? this.reports[this.reports.length - 1] : null;
  }

  /** List drift reports */
  async list(limit = 10): Promise<DriftReport[]> {
    await this.ensureInit();
    return this.reports.slice(-limit);
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  /**
   * Score a single identity rule against recent decisions.
   * Heuristic approach: keyword matching and category alignment.
   *
   * A rule has LOW drift when recent decisions consistently reference
   * the rule's keywords and align with its category.
   * A rule has HIGH drift when recent decisions don't mention it
   * or contradict its principles.
   */
  private scoreRule(
    rule: IdentityRule,
    decisions: DecisionRecord[],
  ): DriftScore {
    const ruleKeywords = this.extractKeywords(rule.statement);
    const relevantDecisions: string[] = [];
    let alignmentScore = 0;

    for (const decision of decisions) {
      const decisionKeywords = this.extractKeywords(
        `${decision.decision} ${decision.rationale}`,
      );

      // Check keyword overlap
      const overlap = this.keywordOverlap(ruleKeywords, decisionKeywords);

      if (overlap > 0.1) {
        relevantDecisions.push(decision.decision);
        alignmentScore += overlap;
      }
    }

    // Normalize alignment score
    const maxPossibleAlignment = decisions.length;
    const normalizedAlignment = maxPossibleAlignment > 0
      ? alignmentScore / maxPossibleAlignment
      : 0.5; // No decisions = moderate drift (uncertain)

    // Drift is inverse of alignment, but we also consider category-specific rules
    // Rules in 'safety' category get extra weight — drift there is more concerning
    let drift = 1 - normalizedAlignment;

    // Category-specific adjustments
    if (rule.category === 'safety' && drift > 0.3) {
      drift = Math.min(1, drift * 1.2); // Amplify safety drift
    }

    // Clamp to [0, 1]
    drift = Math.max(0, Math.min(1, drift));

    const suggestion = this.generateSuggestion(rule, drift, relevantDecisions);

    return {
      rule: rule.name,
      category: rule.category,
      drift,
      relevantDecisions,
      reasoning: drift > 0.5
        ? `No recent decisions align with "${rule.name}" principle. The agent may be acting without reference to this rule.`
        : drift > 0.2
          ? `Some decisions touch on "${rule.name}" but alignment is weak. Consider explicit references.`
          : `Recent decisions align well with "${rule.name}".`,
      suggestion,
    };
  }

  private generateSuggestion(
    rule: IdentityRule,
    drift: number,
    relevantDecisions: string[],
  ): string {
    if (drift > 0.7) {
      return `Critical drift on "${rule.name}": Review recent actions for violations of "${rule.statement}". Re-anchor decisions to this principle.`;
    }
    if (drift > 0.5) {
      return `Significant drift on "${rule.name}": ${relevantDecisions.length} decisions reference this rule. Consciously apply "${rule.statement}" in upcoming work.`;
    }
    if (drift > 0.3) {
      return `Mild drift on "${rule.name}": Could strengthen alignment. Keep "${rule.statement}" in mind for related decisions.`;
    }
    return `"${rule.name}" is well-aligned. Continue current practice.`;
  }

  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be',
      'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'and', 'but', 'or', 'not', 'so', 'yet', 'this', 'that',
      'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your']);

    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w)),
    );
  }

  private keywordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let overlap = 0;
    for (const word of a) {
      if (b.has(word)) overlap++;
    }

    return overlap / Math.max(a.size, b.size);
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.reports, null, 2);
    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, json, 'utf-8');
  }
}
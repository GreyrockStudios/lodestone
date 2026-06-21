/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — RBT Diagnosis (Roses, Buds, Thorns)
 *
 * A structured self-assessment framework. Analyzes recent activity logs
 * to identify Roses (wins, things going well), Buds (potential,
 * things that could grow), and Thorns (problems, things that hurt).
 *
 * Originated in design thinking at Stanford d.school. The three categories
 * force balanced reflection — you don't just dwell on problems.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  /** What happened */
  action: string;
  /** When it happened */
  timestamp: string;
  /** Outcome: success, partial, failure */
  outcome: 'success' | 'partial' | 'failure';
  /** Duration in ms, if applicable */
  durationMs?: number;
  /** Category tag */
  category?: string;
  /** Free-text notes */
  notes?: string;
}

export interface RoseEntry {
  /** What went well */
  what: string;
  /** Evidence from activity logs */
  evidence: string[];
  /** How to replicate or build on it */
  action: string;
}

export interface BudEntry {
  /** What shows potential */
  what: string;
  /** Evidence from activity logs */
  evidence: string[];
  /** What to do to develop it */
  action: string;
}

export interface ThornEntry {
  /** What went wrong */
  what: string;
  /** Evidence from activity logs */
  evidence: string[];
  /** How to fix or mitigate it */
  action: string;
}

export interface RBTReport {
  /** Unique report ID */
  id: string;
  /** Roses — wins and strengths */
  roses: RoseEntry[];
  /** Buds — potential and growth areas */
  buds: BudEntry[];
  /** Thorns — problems and pain points */
  thorns: ThornEntry[];
  /** Overall assessment summary */
  summary: string;
  /** Period this report covers */
  period: {
    from: string;
    to: string;
  };
  /** Activity entries analyzed */
  entriesAnalyzed: number;
  /** Generated at */
  generatedAt: string;
}

// ─── RBT Diagnosis ──────────────────────────────────────────────────────────

export class RBTDiagnosis {
  private reports: RBTReport[] = [];
  private dbPath: string;
  private loaded = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Load RBT reports from disk */
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
   * Analyze recent activity logs and produce a structured RBT report.
   * Classifies activities into Roses (wins), Buds (potential), Thorns (problems).
   */
  async diagnose(recentActivity: ActivityEntry[]): Promise<RBTReport> {
    await this.ensureInit();

    const roses: RoseEntry[] = [];
    const buds: BudEntry[] = [];
    const thorns: ThornEntry[] = [];

    // Group activities by outcome
    const successes = recentActivity.filter(a => a.outcome === 'success');
    const partials = recentActivity.filter(a => a.outcome === 'partial');
    const failures = recentActivity.filter(a => a.outcome === 'failure');

    // ─── Roses: Wins and Strengths ───────────────────────────────────

    // Successful outcomes are roses
    for (const s of successes) {
      // Group by category if available
      const category = s.category || 'general';
      const existing = roses.find(r => r.what === `Successful ${category} actions`);

      if (existing) {
        existing.evidence.push(`${s.action} (${s.timestamp.split('T')[0]})`);
      } else {
        roses.push({
          what: `Successful ${category} actions`,
          evidence: [`${s.action} (${s.timestamp.split('T')[0]})`],
          action: `Continue leveraging ${category} strengths. Consider promoting successful patterns to core instructions.`,
        });
      }
    }

    // Fast completions are roses
    const fastCompletions = successes.filter(a => a.durationMs && a.durationMs < 5000);
    if (fastCompletions.length > 0) {
      roses.push({
        what: 'Fast task completion',
        evidence: fastCompletions.map(a => `${a.action} completed in ${a.durationMs!}ms`),
        action: 'These tasks are well-optimized. Consider if patterns can be reused elsewhere.',
      });
    }

    // ─── Buds: Potential and Growth ───────────────────────────────────

    // Partial successes are buds — they worked partially, showing potential
    for (const p of partials) {
      const category = p.category || 'general';
      buds.push({
        what: `Partially successful ${category} approach`,
        evidence: [`${p.action} had partial success (${p.timestamp.split('T')[0]})`],
        action: `Investigate what blocked full success on "${p.action}". The partial success suggests the approach has merit — iterate, don't abandon.`,
      });
    }

    // Recent new patterns are buds
    const recentActions = recentActivity.slice(-5);
    const categories = new Set(recentActions.map(a => a.category).filter(Boolean));
    for (const category of categories) {
      if (category && !roses.some(r => r.what.includes(category))) {
        buds.push({
          what: `Emerging ${category} activity`,
          evidence: recentActions
            .filter(a => a.category === category)
            .map(a => a.action),
          action: `Monitor ${category} patterns. If consistent, develop into a documented practice.`,
        });
      }
    }

    // ─── Thorns: Problems and Pain Points ─────────────────────────────

    // Failures are thorns
    for (const f of failures) {
      const category = f.category || 'general';
      const existing = thorns.find(t => t.what === `Recurring ${category} failures`);

      if (existing) {
        existing.evidence.push(`${f.action} (${f.timestamp.split('T')[0]})`);
      } else {
        thorns.push({
          what: `Recurring ${category} failures`,
          evidence: [`${f.action} failed (${f.timestamp.split('T')[0]})`],
          action: `Root-cause the ${category} failure. Is it a data issue, logic error, or external dependency? Fix the root cause, not the symptom.`,
        });
      }
    }

    // Slow completions are thorns
    const slowCompletions = recentActivity.filter(a => a.durationMs && a.durationMs > 30000);
    if (slowCompletions.length > 0) {
      thorns.push({
        what: 'Slow task completions',
        evidence: slowCompletions.map(a => `${a.action} took ${Math.round(a.durationMs! / 1000)}s`),
        action: 'Investigate slow operations. Can they be cached, parallelized, or simplified?',
      });
    }

    // ─── Summary ──────────────────────────────────────────────────────

    const summary = this.generateSummary(roses, buds, thorns, recentActivity.length);

    // Determine period
    const timestamps = recentActivity.map(a => a.timestamp).sort();
    const period = {
      from: timestamps[0] || new Date().toISOString(),
      to: timestamps[timestamps.length - 1] || new Date().toISOString(),
    };

    const report: RBTReport = {
      id: `rbt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      roses,
      buds,
      thorns,
      summary,
      period,
      entriesAnalyzed: recentActivity.length,
      generatedAt: new Date().toISOString(),
    };

    this.reports.push(report);
    await this.persist();
    return report;
  }

  /** Get the most recent RBT report */
  async getLatest(): Promise<RBTReport | null> {
    await this.ensureInit();
    return this.reports.length > 0 ? this.reports[this.reports.length - 1] : null;
  }

  /** List RBT reports */
  async list(limit = 10): Promise<RBTReport[]> {
    await this.ensureInit();
    return this.reports.slice(-limit);
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  private generateSummary(
    roses: RoseEntry[],
    buds: BudEntry[],
    thorns: ThornEntry[],
    totalEntries: number,
  ): string {
    const parts: string[] = [];

    if (roses.length > 0) {
      parts.push(`${roses.length} strength${roses.length > 1 ? 's' : ''} to build on`);
    }
    if (buds.length > 0) {
      parts.push(`${buds.length} area${buds.length > 1 ? 's' : ''} of potential to develop`);
    }
    if (thorns.length > 0) {
      parts.push(`${thorns.length} problem${thorns.length > 1 ? 's' : ''} to address`);
    }

    if (parts.length === 0) {
      return `No activity data to analyze (${totalEntries} entries).`;
    }

    const healthIndicator = thorns.length > roses.length
      ? '⚠️ Health is declining — more problems than wins.'
      : thorns.length === roses.length
        ? '⚖️ Mixed signals — roughly equal wins and problems.'
        : '✅ Healthy — more wins than problems.';

    return `Analyzed ${totalEntries} activities: ${parts.join(', ')}. ${healthIndicator}`;
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.reports, null, 2);
    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, json, 'utf-8');
  }
}
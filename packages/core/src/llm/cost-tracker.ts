/**
 * Lodestone Core — Cost Tracking
 *
 * Per-conversation token usage, daily/weekly/monthly cost reports,
 * budget alerts, and cost breakdowns by model and session.
 *
 * Data is stored in an append-only daily log at data/cost-tracking.json.
 * Pricing is configurable per model (input/output token costs).
 * Budget alerts fire at 50%, 75%, and 90% of monthly budget.
 *
 * No external dependencies — uses built-in fs module only.
 */

import { getLogger } from '../utils/logger.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenUsage {
  /** Model identifier (e.g. 'glm-5.2:cloud') */
  model: string;
  /** Input (prompt) tokens consumed */
  inputTokens: number;
  /** Output (completion) tokens consumed */
  outputTokens: number;
}

export interface SessionCost {
  sessionId: string;
  totalTokens: number;
  totalCost: number;
  requests: number;
  /** Per-model breakdown within the session */
  byModel: Record<string, { tokens: number; cost: number; requests: number }>;
}

export interface CostReport {
  /** Period label (e.g. '2026-06-17', '2026-W25', '2026-06') */
  period: string;
  totalCost: number;
  totalTokens: number;
  byModel: Record<string, { tokens: number; cost: number }>;
  bySession: Record<string, number>;
}

export interface BudgetAlert {
  monthlyBudget: number;
  /** Fraction (0-1) at which to warn, e.g. 0.5 for 50% */
  warningThreshold: number;
}

export interface BudgetStatus {
  /** Amount spent this month (in configured currency) */
  spent: number;
  /** Remaining budget */
  remaining: number;
  /** Percentage of budget used (0-100) */
  percentage: number;
  /** Alert messages (empty if no alerts) */
  alerts: string[];
}

export interface CostBreakdown {
  sessionId: string;
  /** Per-request detail */
  requests: Array<{
    timestamp: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  /** Per-model aggregate */
  byModel: Record<string, { tokens: number; cost: number; requests: number }>;
  totalCost: number;
  totalTokens: number;
  totalRequests: number;
}

export interface CostExport {
  exportedAt: string;
  entries: UsageRecord[];
  summary: {
    totalCost: number;
    totalTokens: number;
    totalRequests: number;
    byModel: Record<string, { tokens: number; cost: number }>;
  };
}

/** Internal usage record stored in the append-only log */
interface UsageRecord {
  timestamp: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

// ─── Default Pricing ───────────────────────────────────────────────────────

/** Default per-1K-token pricing for known models (in USD) */
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  'glm-4.5:cloud': { input: 0.15, output: 0.60 },
  'glm-5.2:cloud': { input: 0.50, output: 2.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku': { input: 0.80, output: 4.00 },
  'nomic-embed-text': { input: 0.01, output: 0.0 },
};

// ─── Cost Tracker ────────────────────────────────────────────────────────────

export class CostTracker {
  private log = getLogger('cost-tracker');
  private pricing: Record<string, { input: number; output: number }>;
  private dataFile: string;
  private records: UsageRecord[] = [];
  private loaded = false;
  /** Track which budget thresholds have been alerted (reset each month) */
  private alertedThresholds: Set<number> = new Set();
  /** Current month key for threshold reset */
  private currentMonthKey = '';

  constructor(opts: {
    dataDir: string;
    pricing?: Record<string, { input: number; output: number }>;
  }) {
    this.dataFile = join(opts.dataDir, 'cost-tracking.json');
    this.pricing = { ...DEFAULT_PRICING, ...opts.pricing };
  }

  // ─── Initialization ──────────────────────────────────────────────────────

  /** Load existing records from disk */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.dataFile, 'utf-8');
      this.records = JSON.parse(raw) as UsageRecord[];
      this.log.info(`Loaded ${this.records.length} usage records`, { file: this.dataFile });
    } catch {
      this.records = [];
      await this.persist();
      this.log.info('Initialized new cost tracking file', { file: this.dataFile });
    }
    this.loaded = true;
  }

  /** Ensure data is loaded before use */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  // ─── Recording ──────────────────────────────────────────────────────────

  /**
   * Record token usage for a session.
   * Call after each LLM call completes.
   */
  async recordUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    await this.ensureLoaded();

    const pricing = this.getPricing(usage.model);
    const inputCost = (usage.inputTokens / 1000) * pricing.input;
    const outputCost = (usage.outputTokens / 1000) * pricing.output;
    const totalCost = inputCost + outputCost;

    const record: UsageRecord = {
      timestamp: new Date().toISOString(),
      sessionId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost,
      outputCost,
      totalCost,
    };

    this.records.push(record);
    this.log.debug('Recorded usage', {
      sessionId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: totalCost.toFixed(6),
    });

    await this.persist();
  }

  // ─── Session-Level Queries ────────────────────────────────────────────────

  /** Get total cost for a specific session */
  getSessionCost(sessionId: string): SessionCost {
    const sessionRecords = this.records.filter(r => r.sessionId === sessionId);
    let totalTokens = 0;
    let totalCost = 0;
    const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};

    for (const r of sessionRecords) {
      const tokens = r.inputTokens + r.outputTokens;
      totalTokens += tokens;
      totalCost += r.totalCost;
      if (!byModel[r.model]) {
        byModel[r.model] = { tokens: 0, cost: 0, requests: 0 };
      }
      byModel[r.model].tokens += tokens;
      byModel[r.model].cost += r.totalCost;
      byModel[r.model].requests += 1;
    }

    return {
      sessionId,
      totalTokens,
      totalCost,
      requests: sessionRecords.length,
      byModel,
    };
  }

  /** Get per-request breakdown for a session */
  getCostBreakdown(sessionId: string): CostBreakdown {
    const sessionRecords = this.records.filter(r => r.sessionId === sessionId);
    const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};
    let totalCost = 0;
    let totalTokens = 0;

    const requests = sessionRecords.map(r => {
      const tokens = r.inputTokens + r.outputTokens;
      totalTokens += tokens;
      totalCost += r.totalCost;
      if (!byModel[r.model]) {
        byModel[r.model] = { tokens: 0, cost: 0, requests: 0 };
      }
      byModel[r.model].tokens += tokens;
      byModel[r.model].cost += r.totalCost;
      byModel[r.model].requests += 1;

      return {
        timestamp: r.timestamp,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: r.totalCost,
      };
    });

    return {
      sessionId,
      requests,
      byModel,
      totalCost,
      totalTokens,
      totalRequests: requests.length,
    };
  }

  // ─── Period Reports ───────────────────────────────────────────────────────

  /** Get aggregated cost for a specific day (defaults to today) */
  getDailyCost(date?: Date): CostReport {
    const target = date || new Date();
    const dateStr = target.toISOString().slice(0, 10); // YYYY-MM-DD

    const dayRecords = this.records.filter(r => r.timestamp.startsWith(dateStr));
    return this.buildReport(dateStr, dayRecords);
  }

  /** Get aggregated cost for a week (defaults to current week) */
  getWeeklyCost(weekStart?: Date): CostReport {
    const start = weekStart || this.getWeekStart(new Date());
    const startStr = start.toISOString().slice(0, 10);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const weekRecords = this.records.filter(r => {
      const rDate = new Date(r.timestamp);
      return rDate >= start && rDate < end;
    });

    // ISO week number
    const weekNum = this.getISOWeek(start);
    const period = `${start.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    return this.buildReport(period, weekRecords);
  }

  /** Get aggregated cost for a month (defaults to current month) */
  getMonthlyCost(month?: Date): CostReport {
    const target = month || new Date();
    const monthStr = target.toISOString().slice(0, 7); // YYYY-MM

    const monthRecords = this.records.filter(r => r.timestamp.startsWith(monthStr));
    return this.buildReport(monthStr, monthRecords);
  }

  // ─── Budget ──────────────────────────────────────────────────────────────

  /**
   * Check if usage exceeds budget threshold.
   * Generates alerts at 50%, 75%, and 90% of monthly budget.
   */
  checkBudget(alert: BudgetAlert): BudgetStatus {
    const monthKey = new Date().toISOString().slice(0, 7);

    // Reset alerted thresholds when month changes
    if (this.currentMonthKey !== monthKey) {
      this.currentMonthKey = monthKey;
      this.alertedThresholds.clear();
    }

    const monthlyReport = this.getMonthlyCost();
    const spent = monthlyReport.totalCost;
    const remaining = Math.max(0, alert.monthlyBudget - spent);
    const percentage = alert.monthlyBudget > 0
      ? (spent / alert.monthlyBudget) * 100
      : 0;

    const alerts: string[] = [];
    const thresholds = [0.5, 0.75, 0.9];

    for (const threshold of thresholds) {
      if (percentage >= threshold * 100 && !this.alertedThresholds.has(threshold)) {
        this.alertedThresholds.add(threshold);
        alerts.push(
          `Budget alert: ${Math.round(threshold * 100)}% of monthly budget reached ` +
          `($${spent.toFixed(2)} / $${alert.monthlyBudget.toFixed(2)})`
        );
      }
    }

    // Check custom warning threshold
    if (
      alert.warningThreshold > 0 &&
      percentage >= alert.warningThreshold * 100 &&
      !this.alertedThresholds.has(alert.warningThreshold)
    ) {
      this.alertedThresholds.add(alert.warningThreshold);
      alerts.push(
        `Custom alert: ${Math.round(alert.warningThreshold * 100)}% threshold reached`
      );
    }

    if (percentage >= 100) {
      alerts.push(`Budget exceeded: $${spent.toFixed(2)} / $${alert.monthlyBudget.toFixed(2)}`);
    }

    return { spent, remaining, percentage, alerts };
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  /** Export all cost data as JSON for external reporting */
  export(): CostExport {
    const byModel: Record<string, { tokens: number; cost: number }> = {};
    let totalCost = 0;
    let totalTokens = 0;
    let totalRequests = 0;

    for (const r of this.records) {
      const tokens = r.inputTokens + r.outputTokens;
      totalCost += r.totalCost;
      totalTokens += tokens;
      totalRequests += 1;
      if (!byModel[r.model]) {
        byModel[r.model] = { tokens: 0, cost: 0 };
      }
      byModel[r.model].tokens += tokens;
      byModel[r.model].cost += r.totalCost;
    }

    return {
      exportedAt: new Date().toISOString(),
      entries: this.records,
      summary: {
        totalCost,
        totalTokens,
        totalRequests,
        byModel,
      },
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /** Get pricing for a model, falling back to a default */
  private getPricing(model: string): { input: number; output: number } {
    // Try exact match
    if (this.pricing[model]) return this.pricing[model];
    // Try prefix match (e.g. 'gpt-4o-2024-08-06' matches 'gpt-4o')
    for (const key of Object.keys(this.pricing)) {
      if (model.startsWith(key)) return this.pricing[key];
    }
    // Default: conservative pricing
    this.log.warn(`No pricing found for model '${model}', using default`, { model });
    return { input: 0.50, output: 2.00 };
  }

  /** Build a CostReport from a set of records */
  private buildReport(period: string, records: UsageRecord[]): CostReport {
    const byModel: Record<string, { tokens: number; cost: number }> = {};
    const bySession: Record<string, number> = {};
    let totalCost = 0;
    let totalTokens = 0;

    for (const r of records) {
      const tokens = r.inputTokens + r.outputTokens;
      totalCost += r.totalCost;
      totalTokens += tokens;

      if (!byModel[r.model]) {
        byModel[r.model] = { tokens: 0, cost: 0 };
      }
      byModel[r.model].tokens += tokens;
      byModel[r.model].cost += r.totalCost;

      bySession[r.sessionId] = (bySession[r.sessionId] || 0) + r.totalCost;
    }

    return { period, totalCost, totalTokens, byModel, bySession };
  }

  /** Get the Monday of the current week */
  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Get ISO week number */
  private getISOWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /** Persist records to disk (append-only) */
  private async persist(): Promise<void> {
    try {
      const dir = dirname(this.dataFile);
      await mkdir(dir, { recursive: true });
      await writeFile(this.dataFile, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch (err) {
      this.log.error('Failed to persist cost tracking data', { error: String(err) });
    }
  }
}
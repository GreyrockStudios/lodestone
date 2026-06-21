/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Proactive Intelligence
 *
 * Turns the agent from reactive to proactive. Uses intent prediction,
 * behavioral rules, and context awareness to anticipate needs and
 * act before being asked.
 *
 * No LLM in the policy path — all decisions are deterministic.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync, appendFileSync } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProactiveConfig {
  /** Data directory for proactive state */
  dataDir: string;
  /** Workspace root for scanning */
  workspaceRoot: string;
  /** How often to check for proactive opportunities (ms, default 30 min) */
  checkIntervalMs?: number;
  /** Minimum confidence threshold for proactive action (0-1, default 0.7) */
  minConfidence?: number;
  /** Maximum proactive suggestions per check (default 3) */
  maxSuggestions?: number;
}

export interface ProactiveOpportunity {
  id: string;
  type: 'maintenance' | 'improvement' | 'alert' | 'suggestion' | 'learning';
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  suggestedAction: string;
  confidence: number;
  detectedAt: string;
  context: Record<string, unknown>;
}

export interface ProactiveCheckResult {
  opportunities: ProactiveOpportunity[];
  timestamp: string;
  checksRun: number;
  durationMs: number;
}

// ─── Proactive Intelligence Engine ──────────────────────────────────────────

export class ProactiveIntelligence {
  private config: Required<ProactiveConfig>;
  private history: ProactiveOpportunity[] = [];
  private lastCheck: string | null = null;

  constructor(config: ProactiveConfig) {
    this.config = {
      dataDir: config.dataDir,
      workspaceRoot: config.workspaceRoot,
      checkIntervalMs: config.checkIntervalMs || 30 * 60 * 1000,
      minConfidence: config.minConfidence || 0.7,
      maxSuggestions: config.maxSuggestions || 3,
    };

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
    } catch { /* exists */ }
  }

  async init(): Promise<void> {
    // Load history
    const historyPath = join(this.config.dataDir, 'proactive-history.json');
    if (existsSync(historyPath)) {
      try {
        this.history = JSON.parse(readFileSync(historyPath, 'utf-8'));
      } catch {
        this.history = [];
      }
    }
  }

  /** Run all proactive checks and return opportunities */
  async check(): Promise<ProactiveCheckResult> {
    const start = Date.now();
    const opportunities: ProactiveOpportunity[] = [];

    // 1. Wiki health check — stale pages, broken structure
    opportunities.push(...this.checkWikiHealth());

    // 2. Memory growth check — is the knowledge base growing?
    opportunities.push(...this.checkMemoryGrowth());

    // 3. File system check — disk usage, old temp files
    opportunities.push(...this.checkFileSystem());

    // 4. Session state check — unfinished tasks
    opportunities.push(...this.checkSessionState());

    // 5. Learning queue check — skills that need review
    opportunities.push(...this.checkLearningQueue());

    // Filter by confidence
    const filtered = opportunities
      .filter(o => o.confidence >= this.config.minConfidence)
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      })
      .slice(0, this.config.maxSuggestions);

    // Record
    this.lastCheck = new Date().toISOString();
    this.history.push(...filtered);
    this.saveHistory();

    return {
      opportunities: filtered,
      timestamp: this.lastCheck,
      checksRun: 5,
      durationMs: Date.now() - start,
    };
  }

  // ─── Individual Checks ─────────────────────────────────────────────────

  /** Check wiki for stale pages, missing index, orphan pages */
  private checkWikiHealth(): ProactiveOpportunity[] {
    const ops: ProactiveOpportunity[] = [];
    const wikiDir = join(this.config.workspaceRoot, 'memory/wiki');
    if (!existsSync(wikiDir)) return ops;

    // Check for stale pages (not updated in 30+ days)
    const stalePages: string[] = [];
    this.scanWikiDir(wikiDir, (filePath) => {
      try {
        const stats = statSync(filePath);
        const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
        if (ageDays > 30) {
          stalePages.push(filePath.replace(wikiDir + '/', ''));
        }
      } catch { /* skip */ }
    });

    if (stalePages.length > 5) {
      ops.push({
        id: `wiki-stale-${Date.now()}`,
        type: 'maintenance',
        priority: 'low',
        title: `${stalePages.length} stale wiki pages`,
        description: `${stalePages.length} pages haven't been updated in 30+ days. Consider reviewing for accuracy.`,
        suggestedAction: 'Review stale pages and update or archive them',
        confidence: 0.8,
        detectedAt: new Date().toISOString(),
        context: { stalePages: stalePages.slice(0, 10) },
      });
    }

    // Check for missing index
    const indexPath = join(wikiDir, 'index.md');
    if (!existsSync(indexPath)) {
      ops.push({
        id: `wiki-missing-index-${Date.now()}`,
        type: 'maintenance',
        priority: 'medium',
        title: 'Wiki index missing',
        description: 'The wiki/index.md file is missing. The wiki should have an index for navigation.',
        suggestedAction: 'Generate wiki/index.md with page catalog',
        confidence: 0.9,
        detectedAt: new Date().toISOString(),
        context: {},
      });
    }

    return ops;
  }

  /** Check if memory is growing or stagnating */
  private checkMemoryGrowth(): ProactiveOpportunity[] {
    const ops: ProactiveOpportunity[] = [];
    const memoryDir = join(this.config.workspaceRoot, 'data/lancedb');
    if (!existsSync(memoryDir)) return ops;

    // Check vector memory size
    try {
      const files = readdirSync(memoryDir);
      if (files.length === 0) {
        ops.push({
          id: `memory-empty-${Date.now()}`,
          type: 'alert',
          priority: 'medium',
          title: 'Vector memory is empty',
          description: 'No vectors stored. Memory recall will return nothing. Auto-capture may be disabled.',
          suggestedAction: 'Enable autoCapture or manually store important facts',
          confidence: 0.85,
          detectedAt: new Date().toISOString(),
          context: { memoryDir },
        });
      }
    } catch { /* skip */ }

    return ops;
  }

  /** Check file system for issues */
  private checkFileSystem(): ProactiveOpportunity[] {
    const ops: ProactiveOpportunity[] = [];
    const tmpDir = join(this.config.workspaceRoot, 'data/tmp');

    // Check for old temp files
    if (existsSync(tmpDir)) {
      try {
        const files = readdirSync(tmpDir);
        let oldCount = 0;
        for (const file of files) {
          const stats = statSync(join(tmpDir, file));
          const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > 7) oldCount++;
        }
        if (oldCount > 10) {
          ops.push({
            id: `tmp-cleanup-${Date.now()}`,
            type: 'maintenance',
            priority: 'low',
            title: `${oldCount} old temp files`,
            description: `${oldCount} files in data/tmp are older than 7 days. Safe to clean up.`,
            suggestedAction: 'Remove old temp files to free disk space',
            confidence: 0.75,
            detectedAt: new Date().toISOString(),
            context: { oldCount },
          });
        }
      } catch { /* skip */ }
    }

    return ops;
  }

  /** Check for unfinished session tasks */
  private checkSessionState(): ProactiveOpportunity[] {
    const ops: ProactiveOpportunity[] = [];
    const statePath = join(this.config.workspaceRoot, 'data/session-state.json');

    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        if (state.currentTask && state.currentTask !== 'completed') {
          ops.push({
            id: `session-unfinished-${Date.now()}`,
            type: 'suggestion',
            priority: state.blockedBy ? 'high' : 'medium',
            title: `Unfinished task: ${state.currentTask}`,
            description: `Previous session was working on: ${state.currentTask}. Progress: ${state.progress || 'unknown'}.`,
            suggestedAction: state.blockedBy
              ? `Resolve blocker: ${state.blockedBy}`
              : 'Resume the task from where it was left off',
            confidence: 0.9,
            detectedAt: new Date().toISOString(),
            context: state,
          });
        }
      } catch { /* skip */ }
    }

    return ops;
  }

  /** Check learning queue for items needing review */
  private checkLearningQueue(): ProactiveOpportunity[] {
    const ops: ProactiveOpportunity[] = [];
    const improvementDir = join(this.config.workspaceRoot, 'data/improvement');

    // Check prediction journal for unresolved predictions
    const journalPath = join(improvementDir, 'prediction-journal.json');
    if (existsSync(journalPath)) {
      try {
        const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
        const unresolved = journal.filter((p: { resolved: boolean }) => !p.resolved);
        if (unresolved.length > 5) {
          ops.push({
            id: `predictions-unresolved-${Date.now()}`,
            type: 'learning',
            priority: 'low',
            title: `${unresolved.length} unresolved predictions`,
            description: `${unresolved.length} predictions in the journal haven't been verified. Calibration depends on resolving them.`,
            suggestedAction: 'Review and resolve past predictions to improve calibration',
            confidence: 0.7,
            detectedAt: new Date().toISOString(),
            context: { count: unresolved.length },
          });
        }
      } catch { /* skip */ }
    }

    return ops;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private scanWikiDir(dir: string, callback: (path: string) => void): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          this.scanWikiDir(fullPath, callback);
        } else if (entry.name.endsWith('.md')) {
          callback(fullPath);
        }
      }
    } catch { /* skip */ }
  }

  private saveHistory(): void {
    // Keep only last 100 entries
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }
    const historyPath = join(this.config.dataDir, 'proactive-history.json');
    writeFileSync(historyPath, JSON.stringify(this.history, null, 2));
  }

  /** Get recent opportunities for dashboard */
  getRecent(limit = 10): ProactiveOpportunity[] {
    return this.history.slice(-limit).reverse();
  }

  /** Get stats */
  getStats(): { totalChecks: number; totalOpportunities: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const o of this.history) {
      byType[o.type] = (byType[o.type] || 0) + 1;
    }
    return {
      totalChecks: this.history.length,
      totalOpportunities: this.history.length,
      byType,
    };
  }
}

// ─── Heartbeat Enhancer ─────────────────────────────────────────────────────

/**
 * Enhances the heartbeat with proactive context.
 * Instead of just "check if something needs doing", it provides
 * specific opportunities detected by the proactive intelligence engine.
 */
export class HeartbeatEnhancer {
  private proactive: ProactiveIntelligence;

  constructor(proactive: ProactiveIntelligence) {
    this.proactive = proactive;
  }

  /** Generate heartbeat context — what should the agent focus on? */
  async generateHeartbeatContext(): Promise<string> {
    const result = await this.proactive.check();

    if (result.opportunities.length === 0) {
      return 'No proactive opportunities detected. HEARTBEAT_OK.';
    }

    const lines: string[] = [
      `## Proactive Opportunities (${result.opportunities.length})`,
      `Detected ${result.opportunities.length} opportunities in ${result.durationMs}ms:`,
      '',
    ];

    for (const opp of result.opportunities) {
      const icon = {
        critical: '🚨',
        high: '⚡',
        medium: '📋',
        low: '💡',
      }[opp.priority];

      lines.push(`${icon} **${opp.title}** (${opp.priority} priority)`);
      lines.push(`  ${opp.description}`);
      lines.push(`  Action: ${opp.suggestedAction}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Get the top priority opportunity for immediate action */
  async getTopPriority(): Promise<ProactiveOpportunity | null> {
    const result = await this.proactive.check();
    return result.opportunities[0] || null;
  }
}
/**
 * Lodestone — Patch Automation
 *
 * Extends SelfPatching with automated patch proposal from the sleep cycle,
 * dashboard review endpoints, and automatic rollback on failure.
 *
 * Lifecycle with automation:
 *   1. Sleep cycle detects improvement opportunity
 *   2. PatchAuto.proposeFromDiagnosis() creates a patch
 *   3. Dashboard shows pending patches for human review
 *   4. Human approves/rejects via dashboard
 *   5. PatchAuto.test() validates + tests
 *   6. PatchAuto.apply() applies with auto-rollback on failure
 *   7. Post-apply health check confirms no regression
 *
 * No LLM — all patch generation is template/rule-based.
 */

import { SelfPatching, type SelfPatch, type PatchValidation } from './self-patching.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PatchAutomationConfig {
  /** Data directory */
  dataDir: string;
  /** Self-patching instance */
  patchSystem: SelfPatching;
  /** Project root */
  projectRoot: string;
  /** Whether to auto-rollback on test failure (default: true) */
  autoRollback?: boolean;
  /** Maximum automatic patches per cycle (default: 3) */
  maxAutoPatchesPerCycle?: number;
  /** Health check command (optional) — run after applying to verify */
  healthCheckCommand?: string;
}

export interface PatchProposal {
  source: 'sleep-cycle' | 'drift-correction' | 'calibration' | 'human' | 'template';
  diagnosisId: string;
  description: string;
  rationale: string;
  targetFile: string;
  oldContent: string;
  newContent: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface PatchReview {
  patchId: string;
  reviewer: string;
  decision: 'approve' | 'reject' | 'defer';
  comment: string;
  reviewedAt: string;
}

export interface AutomationStats {
  totalProposed: number;
  autoApproved: number;
  humanApproved: number;
  rejected: number;
  rolledBack: number;
  pendingReview: number;
  healthCheckFailures: number;
  lastCycleAt: string | null;
}

export interface SourceFinding {
  templateId: string;
  description: string;
  rationale: string;
  targetFile: string;
  oldContent: string;
  newContent: string;
  line: number;
}

// ─── Patch Templates ────────────────────────────────────────────────────────

/** Rule-based patch templates — no LLM needed */
const PATCH_TEMPLATES: Record<string, {
  description: string;
  matchPattern: RegExp;
  replacement: (match: string) => string;
  tags: string[];
  priority: PatchProposal['priority'];
}> = {
  'log-console-to-logger': {
    description: 'Replace console.log with structured logger',
    matchPattern: /console\.(log|warn|error)\(/g,
    replacement: (match) => {
      const method = match.includes('warn') ? 'warn' : match.includes('error') ? 'error' : 'info';
      return `logger.${method}(`;
    },
    tags: ['logging', 'code-quality'],
    priority: 'low',
  },
  'add-error-handling': {
    description: 'Add try-catch around async operations that lack error handling',
    matchPattern: /await\s+\w+\.\w+\([^)]*\)\s*;/g,
    replacement: (match) => match, // Template marker — needs context to fill
    tags: ['error-handling', 'safety'],
    priority: 'medium',
  },
  'fix-missing-await': {
    description: 'Add missing await to async calls',
    matchPattern: /^(?!\s*await\s)(\s*\w+\.\w+\(.*\)\s*;)/m,
    replacement: (match) => match, // Template marker
    tags: ['async', 'correctness'],
    priority: 'high',
  },
};

// ─── Patch Automation System ─────────────────────────────────────────────────

export class PatchAutomation {
  private config: Required<PatchAutomationConfig>;
  private reviews: PatchReview[] = [];
  private stats: AutomationStats;
  private patchSystem: SelfPatching;

  constructor(config: PatchAutomationConfig) {
    this.config = {
      dataDir: config.dataDir,
      patchSystem: config.patchSystem,
      projectRoot: config.projectRoot,
      autoRollback: config.autoRollback ?? true,
      maxAutoPatchesPerCycle: config.maxAutoPatchesPerCycle ?? 3,
      healthCheckCommand: config.healthCheckCommand ?? '',
    };
    this.patchSystem = config.patchSystem;

    this.stats = {
      totalProposed: 0,
      autoApproved: 0,
      humanApproved: 0,
      rejected: 0,
      rolledBack: 0,
      healthCheckFailures: 0,
      pendingReview: 0,
      lastCycleAt: null,
    };

    try { mkdirSync(this.config.dataDir, { recursive: true }); } catch { /* exists */ }
  }

  async init(): Promise<void> {
    const reviewPath = join(this.config.dataDir, 'patch-reviews.json');
    if (existsSync(reviewPath)) {
      try {
        this.reviews = JSON.parse(readFileSync(reviewPath, 'utf-8'));
      } catch { /* fresh */ }
    }

    const statsPath = join(this.config.dataDir, 'automation-stats.json');
    if (existsSync(statsPath)) {
      try {
        this.stats = JSON.parse(readFileSync(statsPath, 'utf-8'));
      } catch { /* fresh */ }
    }
  }

  /**
   * Propose a patch from a diagnosis (sleep cycle, drift correction, etc.)
   */
  async proposeFromDiagnosis(proposal: PatchProposal): Promise<SelfPatch | null> {
    this.stats.totalProposed++;

    const patch = await this.patchSystem.propose(
      proposal.description,
      proposal.rationale,
      proposal.targetFile,
      proposal.oldContent,
      proposal.newContent,
      proposal.source === 'human' ? 'human' : 'sleep-cycle',
      proposal.tags,
    );

    if (patch.status === 'failed') {
      return null; // Validation failed
    }

    this.stats.pendingReview = this.patchSystem.getByStatus('validated').length + this.patchSystem.getByStatus('proposed').length;
    await this.saveStats();

    return patch;
  }

  /**
   * Propose patches based on template scanning.
   * Scans actual source files for console.log/warn/error statements
   * and TODO/FIXME comments, generating real patch proposals.
   */
  async proposeFromTemplates(): Promise<SelfPatch[]> {
    const patches: SelfPatch[] = [];

    // Scan source files for patchable patterns
    const findings = this.scanSourceFiles();

    for (const finding of findings) {
      if (patches.length >= this.config.maxAutoPatchesPerCycle) break;

      const template = PATCH_TEMPLATES[finding.templateId];
      if (!template) continue;

      const patch = await this.patchSystem.propose(
        finding.description,
        finding.rationale,
        finding.targetFile,
        finding.oldContent,
        finding.newContent,
        'sleep-cycle',
        template.tags,
      );

      if (patch.status !== 'failed') {
        patches.push(patch);
      }
    }

    return patches;
  }

  /**
   * Scan source files in the project for console.log statements
   * and TODO/FIXME comments that should be migrated or resolved.
   */
  private scanSourceFiles(): SourceFinding[] {
    const findings: SourceFinding[] = [];
    const srcDir = join(this.config.projectRoot, 'src');

    if (!existsSync(srcDir)) return findings;

    const files = this.walkDir(srcDir, ['.ts', '.js', '.tsx', '.jsx']);

    for (const filePath of files) {
      if (findings.length >= this.config.maxAutoPatchesPerCycle * 2) break; // Don't over-scan

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const relPath = relative(this.config.projectRoot, filePath);

          // Pattern 1: console.log / console.warn / console.error → logger
          const consoleMatch = line.match(/console\.(log|warn|error)\(/);
          if (consoleMatch) {
            const method = consoleMatch[1];
            const loggerMethod = method === 'log' ? 'info' : method;
            // Heuristic: don't flag lines that already use logger
            if (!line.includes('logger.') && !line.includes('this.log.')) {
              const oldLine = line;
              const newLine = line.replace(/console\.(log|warn|error)\(/, `logger.${loggerMethod}(`);
              findings.push({
                templateId: 'log-console-to-logger',
                description: `Replace console.${method} with logger.${loggerMethod} in ${relPath}:${i + 1}`,
                rationale: `Automated patch: console.${method} should use the structured Logger for consistent, leveled output. Found at ${relPath} line ${i + 1}.`,
                targetFile: relPath,
                oldContent: oldLine,
                newContent: newLine,
                line: i + 1,
              });
              if (findings.length >= this.config.maxAutoPatchesPerCycle * 2) break;
            }
          }

          // Pattern 2: TODO/FIXME comments → flagged for resolution
          const todoMatch = line.match(/\/\/\s*(TODO|FIXME)[:\s]+(.+)/i);
          if (todoMatch) {
            const kind = todoMatch[1].toUpperCase();
            const text = todoMatch[2].trim();
            // Don't create patches for TODOs that are just reminders — only flag FIXMEs
            if (kind === 'FIXME') {
              findings.push({
                templateId: 'log-console-to-logger', // Reuse tag taxonomy
                description: `Address ${kind} in ${relPath}:${i + 1}: ${text.slice(0, 60)}`,
                rationale: `Automated scan found ${kind} at ${relPath} line ${i + 1}: "${text.slice(0, 80)}". FIXME comments indicate known issues that should be resolved.`,
                targetFile: relPath,
                oldContent: line,
                newContent: line, // No auto-replacement for FIXME — just flags it for human review
                line: i + 1,
              });
              if (findings.length >= this.config.maxAutoPatchesPerCycle * 2) break;
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Deduplicate: only one finding per file+line combination
    const seen = new Set<string>();
    return findings.filter(f => {
      const key = `${f.targetFile}:${f.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Recursively walk a directory, returning all files with matching extensions.
   */
  private walkDir(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        // Skip node_modules, dist, .git, and hidden dirs
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
          results.push(...this.walkDir(fullPath, extensions));
        } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
    return results;
  }

  /**
   * Human reviews a patch via the dashboard.
   */
  async reviewPatch(patchId: string, reviewer: string, decision: PatchReview['decision'], comment: string): Promise<SelfPatch | null> {
    const patch = this.patchSystem.getPatch(patchId);
    if (!patch) return null;

    const review: PatchReview = {
      patchId,
      reviewer,
      decision,
      comment,
      reviewedAt: new Date().toISOString(),
    };

    this.reviews.push(review);

    if (decision === 'approve') {
      this.stats.humanApproved++;
      const approved = await this.patchSystem.approve(patchId);
      if (approved) {
        // Auto-test after approval
        const tested = await this.patchSystem.test(patchId);
        if (tested && tested.status === 'tested') {
          // Auto-apply after successful test
          return await this.applyWithHealthCheck(patchId);
        }
      }
    } else if (decision === 'reject') {
      this.stats.rejected++;
      await this.patchSystem.reject(patchId, comment);
    }
    // 'defer' — leave as-is for later review

    this.stats.pendingReview = this.patchSystem.getByStatus('validated').length + this.patchSystem.getByStatus('proposed').length;
    await this.saveReviews();
    await this.saveStats();

    return patch;
  }

  /**
   * Apply a tested patch and run a health check.
   * If the health check fails, auto-rollback.
   */
  async applyWithHealthCheck(patchId: string): Promise<SelfPatch | null> {
    const patch = this.patchSystem.getPatch(patchId);
    if (!patch || patch.status !== 'tested') return null;

    // Apply the patch
    const applied = await this.patchSystem.apply(patchId);
    if (!applied) return null;

    // Run health check if configured
    if (this.config.healthCheckCommand) {
      const healthOk = await this.runHealthCheck();
      if (!healthOk && this.config.autoRollback) {
        // Rollback immediately
        await this.patchSystem.rollback(patchId);
        this.stats.rolledBack++;
        this.stats.healthCheckFailures++;
        await this.saveStats();
        return null;
      }
    }

    this.stats.pendingReview = this.patchSystem.getByStatus('validated').length + this.patchSystem.getByStatus('proposed').length;
    await this.saveStats();

    return applied;
  }

  /**
   * Run the automation cycle — check for patches that need processing.
   */
  async runCycle(): Promise<{ processed: number; pending: number; rolledBack: number }> {
    const validated = this.patchSystem.getByStatus('validated');
    const approved = this.patchSystem.getByStatus('approved');
    const tested = this.patchSystem.getByStatus('tested');
    let processed = 0;
    let rolledBack = 0;

    // Auto-approve low-risk patches (those with only warnings, no errors in validation)
    for (const patch of validated) {
      if (patch.validation && patch.validation.valid) {
        const errors = patch.validation.checks.filter(c => !c.passed && c.severity === 'error');
        const warnings = patch.validation.checks.filter(c => !c.passed && c.severity === 'warning');

        // Only auto-approve if no errors and minimal warnings, and low-risk tags
        if (errors.length === 0 && warnings.length <= 1 &&
            patch.tags.some(t => ['logging', 'code-quality', 'documentation'].includes(t))) {
          await this.patchSystem.approve(patch.id);
          this.stats.autoApproved++;
          processed++;
        }
      }
    }

    // Test approved patches
    for (const patch of approved) {
      const result = await this.patchSystem.test(patch.id);
      if (result && result.status === 'failed' && this.config.autoRollback) {
        // Mark failed — no rollback needed since it wasn't applied
        rolledBack++;
      }
      processed++;
    }

    // Apply tested patches with health check
    for (const patch of tested) {
      const result = await this.applyWithHealthCheck(patch.id);
      if (!result) {
        rolledBack++;
      }
      processed++;
    }

    this.stats.lastCycleAt = new Date().toISOString();
    this.stats.pendingReview = this.patchSystem.getByStatus('validated').length + this.patchSystem.getByStatus('proposed').length;
    await this.saveStats();

    return {
      processed,
      pending: this.stats.pendingReview,
      rolledBack,
    };
  }

  /**
   * Get patches pending human review.
   */
  getPendingReviews(): SelfPatch[] {
    return [
      ...this.patchSystem.getByStatus('proposed'),
      ...this.patchSystem.getByStatus('validated'),
    ];
  }

  /**
   * Get reviews for a specific patch.
   */
  getReviews(patchId: string): PatchReview[] {
    return this.reviews.filter(r => r.patchId === patchId);
  }

  /**
   * Get automation statistics.
   */
  getStats(): AutomationStats {
    return { ...this.stats };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async runHealthCheck(): Promise<boolean> {
    if (!this.config.healthCheckCommand) return true;

    try {
      const { exec } = await import('child_process');
      return new Promise<boolean>((resolve) => {
        exec(this.config.healthCheckCommand, { timeout: 30000 }, (error) => {
          resolve(!error);
        });
      });
    } catch {
      return false;
    }
  }

  private async saveReviews(): Promise<void> {
    writeFileSync(
      join(this.config.dataDir, 'patch-reviews.json'),
      JSON.stringify(this.reviews.slice(-500), null, 2),
    );
  }

  private async saveStats(): Promise<void> {
    writeFileSync(
      join(this.config.dataDir, 'automation-stats.json'),
      JSON.stringify(this.stats, null, 2),
    );
  }
}
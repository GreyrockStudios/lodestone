/**
 * Lodestone — Sleep Cycle
 *
 * The overnight self-improvement cycle. Inspired by SkillOpt-Sleep
 * (Microsoft Research 2026): Harvest → Mine → Reflect → Consolidate →
 * Validate → Prepare.
 *
 * Each stage processes data from the previous day, extracts insights,
 * and prepares the agent to be smarter tomorrow than it was today.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

import type { MemoryAccess } from '../tools/definitions.js';
import { PredictionJournal, type PredictionEntry, type CalibrationReport } from './prediction-journal.js';
import { DriftDetector, type IdentityRule, type DecisionRecord, type DriftReport } from './drift-detector.js';
import { RBTDiagnosis, type ActivityEntry, type RBTReport } from './rbt-diagnosis.js';
import { SkillEvolver, type Lesson, type EvolveResult } from './skill-evolver.js';
import { CalibrationLoop, type CalibrationLoopResult } from './calibration-loop.js';
import { DriftCorrector, type DriftCorrectionResult } from './drift-correction.js';
import { PatchAutomation } from './patch-automation.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SleepStage =
  | 'harvest'
  | 'mine'
  | 'reflect'
  | 'consolidate'
  | 'validate'
  | 'prepare';

export interface HarvestResult {
  /** Number of predictions found */
  predictionsCount: number;
  /** Number of decisions found */
  decisionsCount: number;
  /** Number of activity entries collected */
  activitiesCount: number;
  /** Number of lessons collected */
  lessonsCount: number;
  /** Timestamp range of harvested data */
  period: { from: string; to: string };
}

export interface MineResult {
  /** Patterns discovered */
  patterns: string[];
  /** Prediction accuracy metrics */
  predictionAccuracy: number;
  /** Decision categories identified */
  decisionCategories: string[];
  /** Lessons ready for validation */
  lessonsForValidation: string[];
}

export interface ReflectionResult {
  /** Self-assessment text */
  assessment: string;
  /** RBT report */
  rbt: RBTReport;
  /** Drift report */
  drift: DriftReport;
  /** Key insights */
  insights: string[];
}

export interface ConsolidationResult {
  /** Wiki pages created or updated */
  wikiUpdates: string[];
  /** Lessons promoted */
  promotions: string[];
  /** Lessons contradicted */
  contradictions: string[];
  /** Skills evolved */
  evolved: EvolveResult;
}

export interface ValidationResult {
  /** Checks that passed */
  passed: string[];
  /** Checks that failed */
  failed: string[];
  /** Contradictions found */
  contradictions: string[];
  /** Whether the cycle is valid overall */
  isValid: boolean;
}

export interface PreparationResult {
  /** Priorities for next cycle */
  priorities: string[];
  /** Predictions to watch */
  pendingPredictions: string[];
  /** Suggested focus areas */
  focusAreas: string[];
}

/** Results from running calibration, drift correction, and patch automation */
export interface PostCycleResult {
  /** Calibration loop result */
  calibration?: CalibrationLoopResult;
  /** Drift correction result */
  driftCorrection?: DriftCorrectionResult;
  /** Patch automation result */
  patchAutomation?: { processed: number; pending: number; rolledBack: number };
  /** Errors from post-cycle modules */
  errors: string[];
}

export interface SleepCycleResult {
  /** When this cycle started */
  startedAt: string;
  /** When this cycle completed */
  completedAt: string;
  /** Duration in ms */
  durationMs: number;
  /** Results from each stage */
  harvest?: HarvestResult;
  mine?: MineResult;
  reflect?: ReflectionResult;
  consolidate?: ConsolidationResult;
  validate?: ValidationResult;
  prepare?: PreparationResult;
  /** Any errors encountered */
  errors: string[];
  /** Stage that completed */
  stagesCompleted: SleepStage[];
  /** Post-cycle module results (calibration, drift, patches) */
  postCycle?: PostCycleResult;
}

// ─── Sleep Cycle ────────────────────────────────────────────────────────────

export class SleepCycle {
  private predictionJournal: PredictionJournal;
  private driftDetector: DriftDetector;
  private rbtDiagnosis: RBTDiagnosis;
  private skillEvolver: SkillEvolver;
  private memory?: MemoryAccess;
  private dataDir: string;

  // Post-cycle modules (optional — injected by ImprovementSystem)
  private calibrationLoop?: CalibrationLoop;
  private driftCorrector?: DriftCorrector;
  private patchAutomation?: PatchAutomation;

  constructor(dataDir: string, memory?: MemoryAccess) {
    this.dataDir = dataDir;
    this.memory = memory;

    this.predictionJournal = new PredictionJournal(join(dataDir, 'predictions.json'));
    this.driftDetector = new DriftDetector(join(dataDir, 'drift-reports.json'));
    this.rbtDiagnosis = new RBTDiagnosis(join(dataDir, 'rbt-reports.json'));
    this.skillEvolver = new SkillEvolver(dataDir);
  }

  /** Wire post-cycle modules from ImprovementSystem */
  setPostCycleModules(modules: {
    calibrationLoop: CalibrationLoop;
    driftCorrector: DriftCorrector;
    patchAutomation: PatchAutomation;
  }): void {
    this.calibrationLoop = modules.calibrationLoop;
    this.driftCorrector = modules.driftCorrector;
    this.patchAutomation = modules.patchAutomation;
  }

  /** Initialize all subsystems */
  async init(): Promise<void> {
    await Promise.all([
      this.predictionJournal.init(),
      this.driftDetector.init(),
      this.rbtDiagnosis.init(),
      this.skillEvolver.init(),
    ]);
  }

  // ─── Full Cycle ─────────────────────────────────────────────────────

  /**
   * Run the complete sleep cycle: Harvest → Mine → Reflect →
   * Consolidate → Validate → Prepare.
   */
  async runFullCycle(context?: {
    identityRules?: IdentityRule[];
    recentDecisions?: DecisionRecord[];
    recentActivity?: ActivityEntry[];
  }): Promise<SleepCycleResult> {
    const startedAt = new Date().toISOString();
    const errors: string[] = [];
    const stagesCompleted: SleepStage[] = [];

    let harvest: HarvestResult | undefined;
    let mine: MineResult | undefined;
    let reflect: ReflectionResult | undefined;
    let consolidate: ConsolidationResult | undefined;
    let validate: ValidationResult | undefined;
    let prepare: PreparationResult | undefined;

    // Stage 1: Harvest
    try {
      harvest = await this.harvest(context?.recentActivity);
      stagesCompleted.push('harvest');
    } catch (err) {
      errors.push(`Harvest failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stage 2: Mine
    try {
      mine = await this.mine(harvest);
      stagesCompleted.push('mine');
    } catch (err) {
      errors.push(`Mine failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stage 3: Reflect
    try {
      reflect = await this.reflect(context?.identityRules, context?.recentDecisions, context?.recentActivity);
      stagesCompleted.push('reflect');
    } catch (err) {
      errors.push(`Reflect failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stage 4: Consolidate
    try {
      consolidate = await this.consolidate(mine, reflect);
      stagesCompleted.push('consolidate');
    } catch (err) {
      errors.push(`Consolidate failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stage 5: Validate
    try {
      validate = await this.validate(consolidate);
      stagesCompleted.push('validate');
    } catch (err) {
      errors.push(`Validate failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stage 6: Prepare
    try {
      prepare = await this.prepare(validate, reflect);
      stagesCompleted.push('prepare');
    } catch (err) {
      errors.push(`Prepare failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Post-cycle: Calibration, Drift Correction, Patch Automation
    let postCycle: PostCycleResult | undefined;
    try {
      postCycle = await this.runPostCycle();
    } catch (err) {
      errors.push(`Post-cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist the cycle result
    const result: SleepCycleResult = {
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      harvest,
      mine,
      reflect,
      consolidate,
      validate,
      prepare,
      errors,
      stagesCompleted,
      postCycle,
    };

    await this.persistCycleResult(result);
    return result;
  }

  // ─── Individual Stages ──────────────────────────────────────────────

  /**
   * Harvest: Collect all new data since the last cycle.
   * Gathers predictions, decisions, activities, and lessons.
   */
  async harvest(recentActivity?: ActivityEntry[]): Promise<HarvestResult> {
    await this.predictionJournal.init();

    const predictions = await this.predictionJournal.list({ status: 'pending' });
    const decisions = recentActivity?.filter(a => a.category === 'decision') || [];
    const activities = recentActivity || [];
    const lessons = await this.skillEvolver.listLessons({ promoted: false });

    // Expire overdue predictions
    await this.predictionJournal.expireOverdue();

    const timestamps = activities.map(a => a.timestamp).sort();
    const period = {
      from: timestamps[0] || new Date().toISOString(),
      to: timestamps[timestamps.length - 1] || new Date().toISOString(),
    };

    return {
      predictionsCount: predictions.length,
      decisionsCount: decisions.length,
      activitiesCount: activities.length,
      lessonsCount: lessons.length,
      period,
    };
  }

  /**
   * Mine: Extract patterns and insights from harvested data.
   * Calculate prediction accuracy, identify decision categories,
   * find lessons ready for validation.
   */
  async mine(harvest?: HarvestResult): Promise<MineResult> {
    const calibration = await this.predictionJournal.calibrate();

    // Extract patterns from prediction confidence vs. reality
    const patterns: string[] = [];
    if (calibration.brierScore > 0.3) {
      patterns.push('Overconfident predictions: consider lowering confidence estimates');
    }
    if (calibration.brierScore < 0.1 && calibration.totalPredictions > 5) {
      patterns.push('Well-calibrated predictions: current approach is working');
    }

    // Find categories in calibration buckets
    for (const bucket of calibration.buckets) {
      if (bucket.total > 3 && bucket.deviation > 0.15) {
        patterns.push(`Confidence ${bucket.range} is ${bucket.hitRate > bucket.idealRate ? 'underconfident' : 'overconfident'} (actual: ${(bucket.hitRate * 100).toFixed(0)}%, expected: ${(bucket.idealRate * 100).toFixed(0)}%)`);
      }
    }

    // Find lessons ready for validation (confidence > 0.5, not yet validated)
    const lessons = await this.skillEvolver.listLessons({ promoted: false, minConfidence: 0.5 });
    const lessonsForValidation = lessons
      .filter(l => l.validations < 2)
      .map(l => l.id);

    // Extract decision categories
    const decisionCategories = [...new Set(
      (await this.skillEvolver.listLessons()).map(l => l.category),
    )];

    return {
      patterns,
      predictionAccuracy: calibration.accuracy,
      decisionCategories,
      lessonsForValidation,
    };
  }

  /**
   * Reflect: Generate self-assessment using RBT and drift detection.
   */
  async reflect(
    identityRules?: IdentityRule[],
    recentDecisions?: DecisionRecord[],
    recentActivity?: ActivityEntry[],
  ): Promise<ReflectionResult> {
    const rbt = await this.rbtDiagnosis.diagnose(recentActivity || []);
    const drift = await this.driftDetector.check(
      identityRules || [],
      recentDecisions || [],
    );

    // Generate self-assessment text
    const insights: string[] = [];

    if (rbt.roses.length > 0) {
      insights.push(`Strengths: ${rbt.roses.map(r => r.what).join(', ')}`);
    }
    if (rbt.thorns.length > 0) {
      insights.push(`Problems: ${rbt.thorns.map(t => t.what).join(', ')}`);
    }
    if (rbt.buds.length > 0) {
      insights.push(`Potential: ${rbt.buds.map(b => b.what).join(', ')}`);
    }

    if (drift.flagged.length > 0) {
      insights.push(`Drift detected on: ${drift.flagged.map(f => f.rule).join(', ')}`);
    }

    if (drift.overallDrift > 0.5) {
      insights.push('⚠️ Significant overall drift — core principles may need re-anchoring');
    }

    const assessment = this.generateAssessment(rbt, drift, insights);

    return {
      assessment,
      rbt,
      drift,
      insights,
    };
  }

  /**
   * Consolidate: Merge insights into wiki, promote skills, evolve lessons.
   */
  async consolidate(
    mine?: MineResult,
    reflect?: ReflectionResult,
  ): Promise<ConsolidationResult> {
    const wikiUpdates: string[] = [];
    const promotions: string[] = [];
    const contradictions: string[] = [];

    // Write RBT report to wiki if memory is available
    if (this.memory && reflect) {
      try {
        const rbtSlug = `areas/self-improvement/rbt-${new Date().toISOString().split('T')[0]}`;
        await this.memory.wikiWrite(rbtSlug, this.formatRBTForWiki(reflect.rbt), {
          title: `RBT Diagnosis ${new Date().toISOString().split('T')[0]}`,
          status: 'active',
          tags: ['rbt', 'self-improvement', 'reflection'],
        });
        wikiUpdates.push(rbtSlug);
      } catch {
        // Wiki write is non-fatal
      }

      // Write drift report to wiki
      try {
        const driftSlug = `areas/self-improvement/drift-${new Date().toISOString().split('T')[0]}`;
        await this.memory.wikiWrite(driftSlug, this.formatDriftForWiki(reflect.drift), {
          title: `Drift Report ${new Date().toISOString().split('T')[0]}`,
          status: 'active',
          tags: ['drift', 'self-improvement', 'reflection'],
        });
        wikiUpdates.push(driftSlug);
      } catch {
        // Wiki write is non-fatal
      }
    }

    // Evolve skills
    const evolved = await this.skillEvolver.evolve();

    // Promote ready lessons
    for (const lessonId of evolved.readyForPromotion) {
      try {
        const lesson = await this.skillEvolver.getLesson(lessonId);
        if (lesson) {
          await this.skillEvolver.promote(lesson.category, lesson.lesson);
          promotions.push(lessonId);
        }
      } catch {
        // Promotion failure is non-fatal
      }
    }

    // Track contradictions
    contradictions.push(...evolved.contradicted);

    return {
      wikiUpdates,
      promotions,
      contradictions,
      evolved,
    };
  }

  /**
   * Validate: Check for contradictions in consolidated knowledge.
   */
  async validate(consolidate?: ConsolidationResult): Promise<ValidationResult> {
    const passed: string[] = [];
    const failed: string[] = [];
    const contradictions: string[] = [];

    // Check: Were lessons promoted?
    if (consolidate && consolidate.promotions.length > 0) {
      passed.push(`${consolidate.promotions.length} lessons promoted to core skills`);
    }

    // Check: Were there contradictions?
    if (consolidate && consolidate.contradictions.length > 0) {
      failed.push(`${consolidate.contradictions.length} contradicted lessons need review`);
      contradictions.push(...consolidate.contradictions);
    }

    // Check: Did wiki updates succeed?
    if (consolidate && consolidate.wikiUpdates.length > 0) {
      passed.push(`${consolidate.wikiUpdates.length} wiki pages updated`);
    }

    // Check: Are there any self-contradictions?
    if (consolidate) {
      const evolved = consolidate.evolved;
      if (evolved.patterns.length > 0) {
        passed.push(`${evolved.patterns.length} skill patterns identified`);
      }
      if (evolved.newPatterns > 0) {
        passed.push(`${evolved.newPatterns} new patterns ready for promotion`);
      }
    }

    const isValid = failed.length === 0 || contradictions.length === 0;

    return {
      passed,
      failed,
      contradictions,
      isValid,
    };
  }

  /**
   * Prepare: Generate next cycle priorities.
   */
  async prepare(
    validate?: ValidationResult,
    reflect?: ReflectionResult,
  ): Promise<PreparationResult> {
    const priorities: string[] = [];
    const focusAreas: string[] = [];

    // If there were validation failures, prioritize them
    if (validate?.failed.length) {
      priorities.push('Review contradicted lessons and resolve contradictions');
    }

    // If drift was detected, prioritize re-alignment
    if (reflect?.drift.flagged.length) {
      priorities.push(`Re-anchor on drifted principles: ${reflect.drift.flagged.map(f => f.rule).join(', ')}`);
      focusAreas.push(...reflect.drift.flagged.map(f => f.rule));
    }

    // If RBT identified thorns, prioritize addressing them
    if (reflect?.rbt.thorns.length) {
      for (const thorn of reflect.rbt.thorns) {
        priorities.push(`Address thorn: ${thorn.what}`);
      }
    }

    // If buds were identified, prioritize developing them
    if (reflect?.rbt.buds.length) {
      for (const bud of reflect.rbt.buds.slice(0, 3)) {
        priorities.push(`Develop bud: ${bud.what}`);
      }
    }

    // Get pending predictions
    const predictions = await this.predictionJournal.list({ status: 'pending' });
    const pendingPredictions = predictions.map(p => p.id);

    // Default priorities if none found
    if (priorities.length === 0) {
      priorities.push('Continue current trajectory — no major issues detected');
    }

    return {
      priorities,
      pendingPredictions,
      focusAreas,
    };
  }

  // ─── Post-Cycle Modules ─────────────────────────────────────────────

  /**
   * Run post-cycle modules: calibration, drift correction, patch automation.
   * These run after the main 6 stages to keep the agent tuned and patched.
   */
  async runPostCycle(): Promise<PostCycleResult> {
    const errors: string[] = [];
    let calibration: CalibrationLoopResult | undefined;
    let driftCorrection: DriftCorrectionResult | undefined;
    let patchAutomationResult: { processed: number; pending: number; rolledBack: number } | undefined;

    // 1. Calibration loop — expire predictions and adjust confidence
    if (this.calibrationLoop) {
      try {
        calibration = await this.calibrationLoop.run();
      } catch (err) {
        errors.push(`Calibration loop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Drift correction — detect and correct behavior drift
    if (this.driftCorrector) {
      try {
        driftCorrection = await this.driftCorrector.checkAndCorrect();
      } catch (err) {
        errors.push(`Drift correction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Patch automation — process pending patch proposals
    if (this.patchAutomation) {
      try {
        patchAutomationResult = await this.patchAutomation.runCycle();
      } catch (err) {
        errors.push(`Patch automation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { calibration, driftCorrection, patchAutomation: patchAutomationResult, errors };
  }

  // ─── Individual Stage Runners (for running stages separately) ───────

  /** Run a single stage of the sleep cycle */
  async runStage(
    stage: SleepStage,
    context?: {
      identityRules?: IdentityRule[];
      recentDecisions?: DecisionRecord[];
      recentActivity?: ActivityEntry[];
    },
  ): Promise<unknown> {
    switch (stage) {
      case 'harvest': return this.harvest(context?.recentActivity);
      case 'mine': return this.mine();
      case 'reflect': return this.reflect(context?.identityRules, context?.recentDecisions, context?.recentActivity);
      case 'consolidate': return this.consolidate();
      case 'validate': return this.validate();
      case 'prepare': return this.prepare();
    }
  }

  // ─── Private ────────────────────────────────────────────────────────

  private generateAssessment(
    rbt: RBTReport,
    drift: DriftReport,
    insights: string[],
  ): string {
    const lines: string[] = [
      '# Self-Assessment',
      '',
      `**Generated:** ${new Date().toISOString()}`,
      `**Entries analyzed:** ${rbt.entriesAnalyzed}`,
      `**Overall drift:** ${(drift.overallDrift * 100).toFixed(0)}%`,
      '',
    ];

    if (insights.length > 0) {
      lines.push('## Key Insights');
      lines.push('');
      for (const insight of insights) {
        lines.push(`- ${insight}`);
      }
      lines.push('');
    }

    lines.push('## Summary');
    lines.push('');
    lines.push(rbt.summary);

    return lines.join('\n');
  }

  private formatRBTForWiki(rbt: RBTReport): string {
    const lines: string[] = [
      `# RBT Diagnosis — ${rbt.generatedAt.split('T')[0]}`,
      '',
      `**Period:** ${rbt.period.from.split('T')[0]} to ${rbt.period.to.split('T')[0]}`,
      `**Entries analyzed:** ${rbt.entriesAnalyzed}`,
      '',
    ];

    if (rbt.roses.length > 0) {
      lines.push('## 🌹 Roses');
      lines.push('');
      for (const rose of rbt.roses) {
        lines.push(`- **${rose.what}** — ${rose.action}`);
        for (const e of rose.evidence) {
          lines.push(`  - ${e}`);
        }
      }
      lines.push('');
    }

    if (rbt.buds.length > 0) {
      lines.push('## 🌱 Buds');
      lines.push('');
      for (const bud of rbt.buds) {
        lines.push(`- **${bud.what}** — ${bud.action}`);
        for (const e of bud.evidence) {
          lines.push(`  - ${e}`);
        }
      }
      lines.push('');
    }

    if (rbt.thorns.length > 0) {
      lines.push('## 🌵 Thorns');
      lines.push('');
      for (const thorn of rbt.thorns) {
        lines.push(`- **${thorn.what}** — ${thorn.action}`);
        for (const e of thorn.evidence) {
          lines.push(`  - ${e}`);
        }
      }
      lines.push('');
    }

    lines.push('## Summary');
    lines.push('');
    lines.push(rbt.summary);

    return lines.join('\n');
  }

  private formatDriftForWiki(drift: DriftReport): string {
    const lines: string[] = [
      `# Drift Report — ${drift.generatedAt.split('T')[0]}`,
      '',
      `**Overall drift:** ${(drift.overallDrift * 100).toFixed(0)}%`,
      `**Rules checked:** ${drift.rulesCount}`,
      `**Decisions analyzed:** ${drift.decisionsCount}`,
      '',
    ];

    if (drift.flagged.length > 0) {
      lines.push('## ⚠️ Flagged Deviations');
      lines.push('');
      for (const flag of drift.flagged) {
        lines.push(`- **${flag.rule}** (${flag.category}): ${(flag.drift * 100).toFixed(0)}% drift — ${flag.reasoning}`);
      }
      lines.push('');
    }

    if (drift.suggestions.length > 0) {
      lines.push('## Suggestions');
      lines.push('');
      for (const suggestion of drift.suggestions) {
        lines.push(`- ${suggestion}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private async persistCycleResult(result: SleepCycleResult): Promise<void> {
    const filePath = join(this.dataDir, 'sleep-cycle', `cycle-${new Date().toISOString().split('T')[0]}.json`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
  }
}
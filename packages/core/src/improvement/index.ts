/**
 * Lodestone — Improvement System
 *
 * The self-improvement subsystem. Wires together prediction journal,
 * drift detection, RBT diagnosis, skill evolution, and the sleep cycle.
 *
 * This is what makes Lodestone not just a chatbot — it gets better over time.
 * Each subsystem reads from and writes to the wiki/memory system.
 * The sleep cycle runs nightly at 3am to harvest, mine, reflect,
 * consolidate, validate, and prepare.
 */

import { join } from 'path';

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../tools/definitions.js';
import type { JobConfig } from '../scheduler/scheduler.js';
import type { MemoryAccess } from '../tools/definitions.js';
import type { SessionManager } from '../session/manager.js';
import type { BehavioralLearning } from '../safety/behavioral-learning.js';

import { PredictionJournal, type PredictionEntry, type CalibrationReport } from './prediction-journal.js';
import { DriftDetector, type IdentityRule, type DecisionRecord, type DriftReport } from './drift-detector.js';
import { RBTDiagnosis, type ActivityEntry, type RBTReport } from './rbt-diagnosis.js';
import { SkillEvolver, type Lesson, type Skill, type EvolveResult } from './skill-evolver.js';
import { SleepCycle, type SleepCycleResult } from './sleep-cycle.js';
import { SelfPatching, type SelfPatch, type PatchValidation, type PatchCheck, type PatchTestResult, type PatchStatus, type SelfPatchingConfig } from './self-patching.js';
import { ProactiveIntelligence, HeartbeatEnhancer, type ProactiveConfig } from './proactive-intelligence.js';
import { CalibrationLoop, type CalibrationLoopConfig, type CalibrationInsight, type CalibrationLoopResult } from './calibration-loop.js';
import { DriftCorrector, DEFAULT_PRINCIPLES, type Principle, type DriftCorrection, type DriftCorrectionResult, type DriftCorrectionConfig } from './drift-correction.js';
import { MultiAgentCoordinator, ReviewSubagent, type SubagentConfig, type SubagentTask, type SubagentResult, type SubagentHandoff, type SubagentStatus } from './multi-agent.js';
import { PatchAutomation, type PatchAutomationConfig, type PatchProposal, type PatchReview, type AutomationStats } from './patch-automation.js';
import { DreamMode, type DreamModeConfig, type DreamReport } from './dream-mode.js';
import { ABTesting, type ABTest, type PromptVariant, type ABOutcome, type VariantResult, type ABResults, type SignificanceResult } from './ab-testing.js';

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ImprovementConfig {
  /** Root directory for improvement data files */
  dataDir: string;
  /** Workspace root (for proactive intelligence scanning) */
  workspaceRoot?: string;
  /** Whether the sleep cycle is enabled */
  sleepCycleEnabled?: boolean;
  /** Cron expression for the sleep cycle (default: 3am daily) */
  sleepCron?: string;
  /** Optional memory access for wiki integration */
  memory?: MemoryAccess;
  /** Session manager (for dream mode) */
  sessionManager?: SessionManager;
  /** Behavioral learning (for dream mode) */
  behavioralLearning?: BehavioralLearning;
}

// ─── Improvement System ─────────────────────────────────────────────────────

export class ImprovementSystem {
  readonly predictionJournal: PredictionJournal;
  readonly driftDetector: DriftDetector;
  readonly rbtDiagnosis: RBTDiagnosis;
  readonly skillEvolver: SkillEvolver;
  readonly sleepCycle: SleepCycle;
  readonly selfPatching: SelfPatching;
  readonly proactive: ProactiveIntelligence;
  readonly heartbeatEnhancer: HeartbeatEnhancer;
  readonly calibrationLoop: CalibrationLoop;
  readonly driftCorrector: DriftCorrector;
  readonly multiAgent: MultiAgentCoordinator;
  readonly reviewSubagent: ReviewSubagent;
  readonly patchAutomation: PatchAutomation;
  readonly dreamMode: DreamMode | null;
  readonly abTesting: ABTesting;

  private config: ImprovementConfig;

  constructor(config: ImprovementConfig) {
    this.config = config;

    const dataDir = config.dataDir;

    this.predictionJournal = new PredictionJournal(join(dataDir, 'predictions.json'));
    this.driftDetector = new DriftDetector(join(dataDir, 'drift-reports.json'));
    this.rbtDiagnosis = new RBTDiagnosis(join(dataDir, 'rbt-reports.json'));
    this.skillEvolver = new SkillEvolver(dataDir);
    this.sleepCycle = new SleepCycle(dataDir, config.memory);
    this.selfPatching = new SelfPatching({
      projectRoot: process.cwd(),
      dataDir: join(dataDir, 'patches'),
      requireHumanApproval: true,
    });
    this.proactive = new ProactiveIntelligence({
      dataDir: join(dataDir, 'proactive'),
      workspaceRoot: config.workspaceRoot || process.cwd(),
    });
    this.heartbeatEnhancer = new HeartbeatEnhancer(this.proactive);
    this.calibrationLoop = new CalibrationLoop({
      dataDir: join(dataDir, 'calibration'),
      journal: this.predictionJournal,
    });
    this.driftCorrector = new DriftCorrector({
      dataDir: join(dataDir, 'drift-corrections'),
      detector: this.driftDetector,
      principles: DEFAULT_PRINCIPLES,
    });
    this.multiAgent = new MultiAgentCoordinator({
      dataDir: join(dataDir, 'multi-agent'),
    });
    this.reviewSubagent = new ReviewSubagent(this.multiAgent);
    this.patchAutomation = new PatchAutomation({
      dataDir: join(dataDir, 'patch-automation'),
      patchSystem: this.selfPatching,
      projectRoot: process.cwd(),
    });
    this.abTesting = new ABTesting(join(dataDir, 'ab-testing'));
    this.dreamMode = config.sessionManager
      ? new DreamMode({
          dataDir: join(dataDir, 'dream'),
          sessionManager: config.sessionManager,
          behavioralLearning: config.behavioralLearning!,
          selfPatching: this.selfPatching,
        } as DreamModeConfig)
      : null;
  }

  /** Initialize all subsystems */
  async init(): Promise<void> {
    await Promise.all([
      this.predictionJournal.init(),
      this.driftDetector.init(),
      this.rbtDiagnosis.init(),
      this.skillEvolver.init(),
      this.selfPatching.init(),
      this.proactive.init(),
      this.calibrationLoop.init(),
      this.driftCorrector.init(),
      this.multiAgent.init(),
      this.patchAutomation.init(),
      this.abTesting.init(),
    ]);
    if (this.dreamMode) {
      await this.dreamMode.init();
    }

    // Wire post-cycle modules into the sleep cycle
    this.sleepCycle.setPostCycleModules({
      calibrationLoop: this.calibrationLoop,
      driftCorrector: this.driftCorrector,
      patchAutomation: this.patchAutomation,
    });
  }

  /** Get the scheduled job config for the sleep cycle */
  getSleepCycleJob(): JobConfig {
    return {
      id: 'improvement-sleep-cycle',
      name: 'Self-Improvement Sleep Cycle',
      description: 'Nightly self-improvement cycle: harvest data, mine patterns, reflect on performance, consolidate insights, validate knowledge, and prepare priorities.',
      schedule: {
        kind: 'cron',
        expr: this.config.sleepCron || '0 3 * * *', // 3am daily
        tz: 'America/Toronto',
      },
      enabled: this.config.sleepCycleEnabled !== false,
      timeoutSeconds: 600, // 10 minutes max
    };
  }

  /** Get the scheduled job config for the proactive heartbeat */
  getHeartbeatJob(): JobConfig {
    return {
      id: 'improvement-heartbeat',
      name: 'Proactive Intelligence Heartbeat',
      description: 'Periodic heartbeat: scans for proactive opportunities (stale wiki, empty memory, unfinished tasks, unresolved predictions).',
      schedule: {
        kind: 'interval',
        everyMs: 30 * 60 * 1000, // 30 minutes
      },
      enabled: true,
      timeoutSeconds: 60, // 1 minute max
    };
  }

  /** Get all improvement-related tools */
  getTools(): Tool[] {
    return [
      new PredictionJournalTool(this.predictionJournal),
      new DriftCheckTool(this.driftDetector),
      new RBTDiagnoseTool(this.rbtDiagnosis),
      new SkillLearnTool(this.skillEvolver),
    ];
  }
}

// ─── Tool Implementations ────────────────────────────────────────────────────

// --- Prediction Journal Tool ---

const predictionJournalDef: ToolDefinition = {
  id: 'prediction-journal',
  name: 'Prediction Journal',
  description: 'Log predictions before acting, resolve them with actual outcomes, and check calibration.',
  parameters: [
    { name: 'action', description: 'predict, resolve, calibrate, list, or get', type: 'string', required: true },
    { name: 'task', description: 'What you are predicting (for predict action)', type: 'string', required: false },
    { name: 'expectedOutcome', description: 'What you expect to happen', type: 'string', required: false },
    { name: 'confidence', description: 'Confidence level 0-1', type: 'number', required: false },
    { name: 'deadline', description: 'ISO timestamp when this should be resolved by', type: 'string', required: false },
    { name: 'tags', description: 'Tags for categorization', type: 'array', required: false, items: { name: 'tag', description: 'A tag', type: 'string', required: false } },
    { name: 'predictionId', description: 'Prediction ID for resolve/get', type: 'string', required: false },
    { name: 'actualOutcome', description: 'What actually happened (for resolve action)', type: 'string', required: false },
    { name: 'status', description: 'Filter by status for list (pending, met, missed, expired)', type: 'string', required: false },
    { name: 'limit', description: 'Max results for list', type: 'number', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class PredictionJournalTool implements Tool {
  readonly definition = predictionJournalDef;

  constructor(private journal: PredictionJournal) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'predict': {
          if (!params.task || !params.expectedOutcome || params.confidence === undefined) {
            return {
              success: false, data: null,
              summary: 'Missing required fields for predict',
              error: 'task, expectedOutcome, and confidence are required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const entry = await this.journal.predict(
            params.task as string,
            params.expectedOutcome as string,
            params.confidence as number,
            (params.deadline as string) || new Date(Date.now() + 86400000).toISOString(), // Default 24h
            params.tags as string[] | undefined,
          );
          return {
            success: true, data: entry,
            summary: `Prediction ${entry.id} logged: "${params.task}" at ${(entry.confidence * 100).toFixed(0)}% confidence`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'resolve': {
          if (!params.predictionId || !params.actualOutcome) {
            return {
              success: false, data: null,
              summary: 'Missing required fields for resolve',
              error: 'predictionId and actualOutcome are required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const entry = await this.journal.resolve(
            params.predictionId as string,
            params.actualOutcome as string,
          );
          return {
            success: true, data: entry,
            summary: `Prediction ${entry.id} resolved as "${entry.status}"`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'calibrate': {
          const report = await this.journal.calibrate();
          return {
            success: true, data: report,
            summary: `Calibration: Brier score ${report.brierScore.toFixed(3)}, accuracy ${(report.accuracy * 100).toFixed(0)}%, ${report.totalPredictions} predictions resolved`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list': {
          const entries = await this.journal.list({
            status: params.status as PredictionEntry['status'] | undefined,
            limit: params.limit as number | undefined,
          });
          return {
            success: true, data: entries,
            summary: `${entries.length} predictions`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'get': {
          if (!params.predictionId) {
            return {
              success: false, data: null,
              summary: 'Missing predictionId',
              error: 'predictionId is required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const entry = await this.journal.get(params.predictionId as string);
          if (!entry) {
            return {
              success: false, data: null,
              summary: `Prediction ${params.predictionId} not found`,
              error: 'Not found',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          return {
            success: true, data: entry,
            summary: `Prediction ${entry.id}: "${entry.task}" — ${entry.status}`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: predict, resolve, calibrate, list, get',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: 'Prediction journal error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}

// --- Drift Check Tool ---

const driftCheckDef: ToolDefinition = {
  id: 'drift-check',
  name: 'Drift Detector',
  description: 'Check if recent behavior has drifted from core principles. Compare decisions against identity rules.',
  parameters: [
    { name: 'action', description: 'check, latest, or list', type: 'string', required: true },
    { name: 'identityRules', description: 'Array of identity rules to check against', type: 'array', required: false, items: { name: 'rule', description: 'An identity rule', type: 'object', required: false, properties: { name: { name: 'name', description: 'Rule name', type: 'string', required: true }, statement: { name: 'statement', description: 'Rule statement', type: 'string', required: true }, category: { name: 'category', description: 'Rule category', type: 'string', required: true }, weight: { name: 'weight', description: 'Importance 0-1', type: 'number', required: false } } } },
    { name: 'recentDecisions', description: 'Array of recent decisions to analyze', type: 'array', required: false, items: { name: 'decision', description: 'A decision', type: 'object', required: false, properties: { decision: { name: 'decision', description: 'What was decided', type: 'string', required: true }, rationale: { name: 'rationale', description: 'Why', type: 'string', required: true }, timestamp: { name: 'timestamp', description: 'When', type: 'string', required: true }, tags: { name: 'tags', description: 'Tags', type: 'array', required: false, items: { name: 'tag', description: 'A tag', type: 'string', required: false } } } } },
    { name: 'limit', description: 'Max reports for list action', type: 'number', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class DriftCheckTool implements Tool {
  readonly definition = driftCheckDef;

  constructor(private detector: DriftDetector) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'check': {
          const rules = (params.identityRules as IdentityRule[]) || [];
          const decisions = (params.recentDecisions as DecisionRecord[]) || [];

          if (rules.length === 0) {
            // Use identity from context
            const identityRules: IdentityRule[] = [
              { name: 'safety', statement: context.identity.rules || 'No safety rules loaded', category: 'safety', weight: 1.0 },
            ];
            return {
              success: true, data: { overallDrift: 0, flagged: [], suggestions: ['Load identity rules for drift detection'] },
              summary: 'No identity rules provided — using defaults',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }

          const report = await this.detector.check(rules, decisions);
          const driftPct = (report.overallDrift * 100).toFixed(0);
          return {
            success: true, data: report,
            summary: `Drift check: ${driftPct}% overall drift, ${report.flagged.length} flagged deviations`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'latest': {
          const report = await this.detector.getLatest();
          if (!report) {
            return {
              success: true, data: null,
              summary: 'No drift reports yet',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          return {
            success: true, data: report,
            summary: `Latest drift: ${(report.overallDrift * 100).toFixed(0)}% overall, ${report.flagged.length} flagged`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list': {
          const reports = await this.detector.list((params.limit as number) || 10);
          return {
            success: true, data: reports,
            summary: `${reports.length} drift reports`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: check, latest, list',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: 'Drift detector error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}

// --- RBT Diagnose Tool ---

const rbtDiagnoseDef: ToolDefinition = {
  id: 'rbt-diagnose',
  name: 'RBT Diagnosis',
  description: 'Analyze recent activity for Roses (wins), Buds (potential), and Thorns (problems). Structured self-assessment.',
  parameters: [
    { name: 'action', description: 'diagnose, latest, or list', type: 'string', required: true },
    { name: 'activities', description: 'Array of activity entries to analyze', type: 'array', required: false, items: { name: 'activity', description: 'An activity entry', type: 'object', required: false, properties: { action: { name: 'action', description: 'What happened', type: 'string', required: true }, timestamp: { name: 'timestamp', description: 'When', type: 'string', required: true }, outcome: { name: 'outcome', description: 'success, partial, or failure', type: 'string', required: true }, durationMs: { name: 'durationMs', description: 'Duration in ms', type: 'number', required: false }, category: { name: 'category', description: 'Category tag', type: 'string', required: false }, notes: { name: 'notes', description: 'Additional notes', type: 'string', required: false } } } },
    { name: 'limit', description: 'Max reports for list action', type: 'number', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class RBTDiagnoseTool implements Tool {
  readonly definition = rbtDiagnoseDef;

  constructor(private diagnosis: RBTDiagnosis) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'diagnose': {
          const activities = (params.activities as ActivityEntry[]) || [];
          const report = await this.diagnosis.diagnose(activities);
          return {
            success: true, data: report,
            summary: `RBT: ${report.roses.length} roses, ${report.buds.length} buds, ${report.thorns.length} thorns — ${report.summary}`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'latest': {
          const report = await this.diagnosis.getLatest();
          if (!report) {
            return {
              success: true, data: null,
              summary: 'No RBT reports yet',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          return {
            success: true, data: report,
            summary: `Latest RBT: ${report.roses.length} roses, ${report.buds.length} buds, ${report.thorns.length} thorns`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list': {
          const reports = await this.diagnosis.list((params.limit as number) || 10);
          return {
            success: true, data: reports,
            summary: `${reports.length} RBT reports`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: diagnose, latest, list',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: 'RBT diagnosis error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}

// --- Skill Learn Tool ---

const skillLearnDef: ToolDefinition = {
  id: 'skill-learn',
  name: 'Skill Evolver',
  description: 'Record lessons from experience, promote learned skills to core instructions, and evolve patterns.',
  parameters: [
    { name: 'action', description: 'learn, validate, contradict, promote, evolve, list-lessons, or list-skills', type: 'string', required: true },
    { name: 'lesson', description: 'The lesson learned (for learn action)', type: 'string', required: false },
    { name: 'context', description: 'Context where the lesson was learned', type: 'string', required: false },
    { name: 'category', description: 'Category: coding, communication, decision-making, safety, quality, etc.', type: 'string', required: false },
    { name: 'source', description: 'How learned: trial-and-error, observation, feedback, reflection', type: 'string', required: false },
    { name: 'tags', description: 'Tags for grouping', type: 'array', required: false, items: { name: 'tag', description: 'A tag', type: 'string', required: false } },
    { name: 'lessonId', description: 'Lesson ID for validate/contradict', type: 'string', required: false },
    { name: 'skillName', description: 'Skill name for promote', type: 'string', required: false },
    { name: 'instruction', description: 'Custom instruction for promoted skill', type: 'string', required: false },
    { name: 'category', description: 'Filter category for list-lessons', type: 'string', required: false },
    { name: 'promoted', description: 'Filter promoted status for list-lessons', type: 'boolean', required: false },
    { name: 'minConfidence', description: 'Minimum confidence for list-lessons', type: 'number', required: false },
    { name: 'limit', description: 'Max results for list', type: 'number', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class SkillLearnTool implements Tool {
  readonly definition = skillLearnDef;

  constructor(private evolver: SkillEvolver) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'learn': {
          if (!params.lesson || !params.context || !params.category) {
            return {
              success: false, data: null,
              summary: 'Missing required fields for learn',
              error: 'lesson, context, and category are required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const entry = await this.evolver.learnLesson(
            params.lesson as string,
            params.context as string,
            params.category as string,
            (params.source as Lesson['source']) || 'reflection',
            params.tags as string[] | undefined,
          );
          return {
            success: true, data: entry,
            summary: `Lesson learned: "${entry.lesson}" (${entry.id})`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'validate': {
          if (!params.lessonId) {
            return {
              success: false, data: null,
              summary: 'Missing lessonId',
              error: 'lessonId is required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const entry = await this.evolver.validate(params.lessonId as string);
          return {
            success: true, data: entry,
            summary: `Lesson ${entry.id} validated (confidence: ${(entry.confidence * 100).toFixed(0)}%)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'contradict': {
          if (!params.lessonId) {
            return {
              success: false, data: null,
              summary: 'Missing lessonId',
              error: 'lessonId is required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const entry = await this.evolver.contradict(params.lessonId as string);
          return {
            success: true, data: entry,
            summary: `Lesson ${entry.id} contradicted (confidence: ${(entry.confidence * 100).toFixed(0)}%)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'promote': {
          if (!params.skillName) {
            return {
              success: false, data: null,
              summary: 'Missing skillName',
              error: 'skillName is required',
              durationMs: Date.now() - start,
              includeInContext: true,
            };
          }
          const skill = await this.evolver.promote(
            params.skillName as string,
            params.instruction as string | undefined,
          );
          return {
            success: true, data: skill,
            summary: `Skill "${skill.name}" promoted to core instructions`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'evolve': {
          const result = await this.evolver.evolve();
          return {
            success: true, data: result,
            summary: `Evolution: ${result.newPatterns} new patterns, ${result.readyForPromotion.length} ready for promotion, ${result.contradicted.length} contradicted`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list-lessons': {
          const lessons = await this.evolver.listLessons({
            category: params.category as string | undefined,
            promoted: params.promoted as boolean | undefined,
            minConfidence: params.minConfidence as number | undefined,
            limit: params.limit as number | undefined,
          });
          return {
            success: true, data: lessons,
            summary: `${lessons.length} lessons`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list-skills': {
          const skills = await this.evolver.listSkills();
          return {
            success: true, data: skills,
            summary: `${skills.length} promoted skills`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: learn, validate, contradict, promote, evolve, list-lessons, list-skills',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: 'Skill evolver error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
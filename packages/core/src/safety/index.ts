/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Safety Module
 *
 * Capability tiers, behavioral learning, and evidence-gated memory promotion.
 * These are the guardrails that make the agent trustworthy.
 */

import { CapabilityManager, type CapabilityTier, type TierConfig, type SimulationResult } from './capability-tiers.js';
import { BehavioralLearning, type BehavioralRule, type CorrectionInput, type BehavioralLearningConfig } from './behavioral-learning.js';
import { MemoryPromotion, type VerificationLevel, type MemoryCandidate, type VerificationResult, type ConflictEntry, type MemoryPromotionConfig } from './memory-promotion.js';
import { IntentPredictor, type IntentPredictionResult, type IntentPredictionConfig, type IntentCategory, type IntentUrgency } from './intent-prediction.js';
import { QualityGate, type QualityGateResult, type QualityGateConfig, type QualityGateInput, type GateOutputType, type GateDecision } from './quality-gates.js';
import { ConfidenceDisplay, type ConfidenceScore, type ConfidenceContext, type CalibrationData } from './confidence-display.js';
import { FailureReplay, type FailureReplayConfig, type DecisionTrace, type FailureAnalysis, type FailureSignal, type PreventionRule } from './failure-replay.js';
import { SelfConstraints, type SelfConstraintsConfig, type NearMissEvent, type ConstraintProposal, type ActiveConstraint, type ActionRecord } from './self-constraints.js';
import { ExplainabilityLayer, type ExplainTrace, type ExplainStep } from './explainability.js';
import { getLogger, Logger } from '../utils/logger.js';

export { CapabilityManager, type CapabilityTier, type TierConfig, type SimulationResult } from './capability-tiers.js';
export { BehavioralLearning, type BehavioralRule, type CorrectionInput, type BehavioralLearningConfig } from './behavioral-learning.js';
export { MemoryPromotion, type VerificationLevel, type MemoryCandidate, type VerificationResult, type ConflictEntry, type MemoryPromotionConfig } from './memory-promotion.js';
export { IntentPredictor, type IntentPredictionResult, type IntentPredictionConfig, type IntentCategory, type IntentUrgency } from './intent-prediction.js';
export { QualityGate, type QualityGateResult, type QualityGateConfig, type QualityGateInput, type GateOutputType, type GateDecision } from './quality-gates.js';

// ─── Safety System Config ────────────────────────────────────────────────────

export interface SafetyConfig {
  /** Root directory for safety data files */
  dataDir: string;
  /** Custom tier overrides */
  customTiers?: Record<string, Partial<TierConfig>>;
  /** Behavioral learning config overrides */
  behavioralLearning?: Partial<BehavioralLearningConfig>;
  /** Memory promotion config overrides */
  memoryPromotion?: Partial<MemoryPromotionConfig>;
  /** Intent prediction config overrides */
  intentPrediction?: Partial<IntentPredictionConfig>;
  /** Quality gate config overrides */
  qualityGate?: Partial<QualityGateConfig>;
  /** Failure replay config */
  failureReplay?: { maxTraces?: number; maxFailures?: number; detectionWindow?: number };
  /** Self constraints config */
  selfConstraints?: { maxConstraints?: number; detectionWindow?: number; autoApprove?: boolean };
}

// ─── Safety System ──────────────────────────────────────────────────────────

export class SafetySystem {
  readonly capabilities: CapabilityManager;
  readonly behavioralLearning: BehavioralLearning;
  readonly memoryPromotion: MemoryPromotion;
  readonly intentPredictor: IntentPredictor;
  readonly qualityGate: QualityGate;
  readonly confidenceDisplay: ConfidenceDisplay;
  readonly failureReplay: FailureReplay;
  readonly selfConstraints: SelfConstraints;
  readonly explainability: ExplainabilityLayer;

  private config: SafetyConfig;
  private logger = getLogger('Safety');

  constructor(config: SafetyConfig) {
    this.config = config;

    this.capabilities = new CapabilityManager(config.customTiers);
    this.behavioralLearning = new BehavioralLearning({
      dataDir: `${config.dataDir}/behavioral`,
      maxRules: config.behavioralLearning?.maxRules,
      minConfidence: config.behavioralLearning?.minConfidence,
    });
    this.memoryPromotion = new MemoryPromotion({
      dataDir: `${config.dataDir}/promotion`,
      autoPromotionLevel: config.memoryPromotion?.autoPromotionLevel,
      maxQueueSize: config.memoryPromotion?.maxQueueSize,
    });
    this.intentPredictor = new IntentPredictor({
      dataDir: `${config.dataDir}/intent`,
      maxHistory: config.intentPrediction?.maxHistory,
      minConfidence: config.intentPrediction?.minConfidence,
      enableProactive: config.intentPrediction?.enableProactive,
    });
    this.qualityGate = new QualityGate({
      dataDir: `${config.dataDir}/quality`,
      thresholds: config.qualityGate?.thresholds,
      gatedTypes: config.qualityGate?.gatedTypes,
      useLLMReview: config.qualityGate?.useLLMReview,
    });
    this.confidenceDisplay = new ConfidenceDisplay();
    this.explainability = new ExplainabilityLayer();
    this.failureReplay = new FailureReplay({
      dataDir: `${config.dataDir}/failure-replay`,
      logger: getLogger('failure-replay') as Logger,
      maxTraces: config.failureReplay?.maxTraces ?? 1000,
      maxArchivedFailures: config.failureReplay?.maxFailures ?? 100,
      existingRules: this.behavioralLearning.getActiveRules(),
    });
    this.selfConstraints = new SelfConstraints({
      dataDir: `${config.dataDir}/self-constraints`,
      maxProposals: config.selfConstraints?.maxConstraints ?? 50,
    });
  }

  /** Initialize all safety subsystems */
  async init(): Promise<void> {
    await Promise.all([
      this.behavioralLearning.init(),
      this.memoryPromotion.init(),
      this.intentPredictor.init(),
      this.qualityGate.init(),
      this.failureReplay.init(),
      this.selfConstraints.init(),
    ].filter(p => p !== undefined));
    this.logger.info('Safety system initialized');
    const summary = this.capabilities.getTierSummary();
    this.logger.info('Capabilities', { tools: Object.values(summary).reduce((sum, t) => sum + t.count, 0), tiers: 4 });
    this.logger.info('Behavioral rules', { active: this.behavioralLearning.getActiveRules().length });
    this.logger.info('Intent predictor', { predictions: this.intentPredictor.getStats().totalPredictions });
    this.logger.info('Quality gate', { approved: this.qualityGate.getStatus().recentDecisions.approve });
  }

  /** Get behavioral rules formatted for prompt injection */
  getRulesForPrompt(): string {
    return this.behavioralLearning.formatRulesForPrompt();
  }

  /** Check if a tool can be auto-approved */
  canAutoApprove(toolId: string): boolean {
    return this.capabilities.canAutoApprove(toolId);
  }

  /** Check if a tool can run in sleep/heartbeat mode */
  canRunInSleep(toolId: string): boolean {
    return this.capabilities.canRunInSleep(toolId);
  }

  /** Simulate a privileged tool execution */
  simulate(toolId: string, params: Record<string, unknown>): SimulationResult {
    return this.capabilities.simulate(toolId, params);
  }

  /** Detect if a user message is a correction and extract a rule */
  processCorrection(input: CorrectionInput): BehavioralRule | null {
    const detection = this.behavioralLearning.detectCorrection(input);
    if (detection.isCorrection) {
      return this.behavioralLearning.extractRule(input);
    }
    return null;
  }

  /** Submit a memory candidate for promotion */
  async submitMemoryForPromotion(claim: string, source: string, category: MemoryCandidate['category'], tags: string[]): Promise<MemoryCandidate> {
    return this.memoryPromotion.submit(claim, source, category, tags);
  }
}
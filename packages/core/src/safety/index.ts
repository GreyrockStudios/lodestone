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
}

// ─── Safety System ──────────────────────────────────────────────────────────

export class SafetySystem {
  readonly capabilities: CapabilityManager;
  readonly behavioralLearning: BehavioralLearning;
  readonly memoryPromotion: MemoryPromotion;
  readonly intentPredictor: IntentPredictor;
  readonly qualityGate: QualityGate;

  private config: SafetyConfig;

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
  }

  /** Initialize all safety subsystems */
  async init(): Promise<void> {
    await Promise.all([
      this.behavioralLearning.init(),
      this.memoryPromotion.init(),
      this.intentPredictor.init(),
      this.qualityGate.init(),
    ]);
    console.log('[Lodestone] Safety system initialized');
    const summary = this.capabilities.getTierSummary();
    console.log(`[Lodestone]   Capabilities: ${Object.values(summary).reduce((sum, t) => sum + t.count, 0)} tools across 4 tiers`);
    console.log(`[Lodestone]   Behavioral rules: ${this.behavioralLearning.getActiveRules().length} active`);
    console.log(`[Lodestone]   Intent predictor: ${this.intentPredictor.getStats().totalPredictions} predictions logged`);
    console.log(`[Lodestone]   Quality gate: ${this.qualityGate.getStatus().recentDecisions.approve} approved`);
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
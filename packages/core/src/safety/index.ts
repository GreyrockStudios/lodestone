/**
 * Lodestone — Safety Module
 *
 * Capability tiers, behavioral learning, and evidence-gated memory promotion.
 * These are the guardrails that make the agent trustworthy.
 */

import { CapabilityManager, type CapabilityTier, type TierConfig, type SimulationResult } from './capability-tiers.js';
import { BehavioralLearning, type BehavioralRule, type CorrectionInput, type BehavioralLearningConfig } from './behavioral-learning.js';
import { MemoryPromotion, type VerificationLevel, type MemoryCandidate, type VerificationResult, type ConflictEntry, type MemoryPromotionConfig } from './memory-promotion.js';

export { CapabilityManager, type CapabilityTier, type TierConfig, type SimulationResult } from './capability-tiers.js';
export { BehavioralLearning, type BehavioralRule, type CorrectionInput, type BehavioralLearningConfig } from './behavioral-learning.js';
export { MemoryPromotion, type VerificationLevel, type MemoryCandidate, type VerificationResult, type ConflictEntry, type MemoryPromotionConfig } from './memory-promotion.js';

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
}

// ─── Safety System ──────────────────────────────────────────────────────────

export class SafetySystem {
  readonly capabilities: CapabilityManager;
  readonly behavioralLearning: BehavioralLearning;
  readonly memoryPromotion: MemoryPromotion;

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
  }

  /** Initialize all safety subsystems */
  async init(): Promise<void> {
    await Promise.all([
      this.behavioralLearning.init(),
      this.memoryPromotion.init(),
    ]);
    console.log('[Lodestone] Safety system initialized');
    const summary = this.capabilities.getTierSummary();
    console.log(`[Lodestone]   Capabilities: ${Object.values(summary).reduce((sum, t) => sum + t.count, 0)} tools across 4 tiers`);
    console.log(`[Lodestone]   Behavioral rules: ${this.behavioralLearning.getActiveRules().length} active`);
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
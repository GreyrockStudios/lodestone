/**
 * Lodestone — Self-Imposed Constraints
 *
 * The agent proposes new safety rules based on near-misses.
 * When something almost goes wrong (secret nearly leaked, dangerous
 * command nearly executed), the agent proposes a constraint to prevent
 * it in future. All proposals require human approval.
 *
 * Lifecycle:
 *   NEAR-MISS DETECTED → CONSTRAINT PROPOSED → HUMAN APPROVES/REJECTS
 *   Approved constraints are added to BehavioralLearning as active rules.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import type { BehavioralLearning } from './behavioral-learning.js';
import type { TruthBinding, GuardResult } from './truth-binding.js';
import type { CapabilityManager, SimulationResult } from './capability-tiers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NearMissType =
  | 'secret-leak'
  | 'dangerous-command'
  | 'unverified-claim'
  | 'rate-limit-near'
  | 'wrong-target'
  | 'prompt-leak'
  | 'excessive-hedging';

export type ConstraintSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ConstraintAction = 'block' | 'warn' | 'log';

export interface NearMissEvent {
  /** Unique event ID */
  id: string;
  /** Type of near-miss */
  type: NearMissType;
  /** What happened */
  description: string;
  /** What was almost affected */
  whatAlmostHappened: string;
  /** What caught it (e.g., 'truth-binding', 'capability-tiers', 'human') */
  caughtBy: string;
  /** The specific guard/check that triggered */
  guardName?: string;
  /** The content that triggered the near-miss (redacted if sensitive) */
  triggerContent: string;
  /** When it happened */
  timestamp: string;
  /** Session ID where it occurred */
  sessionId?: string;
  /** Severity of the near-miss */
  severity: ConstraintSeverity;
  /** Related guard results (if from truth-binding) */
  guardResults?: GuardResult[];
  /** Related simulation results (if from capability-tiers) */
  simulationResult?: SimulationResult;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface ConstraintProposal {
  /** Unique proposal ID */
  id: string;
  /** The near-miss that triggered this proposal */
  nearMissId: string;
  /** Human-readable name for the constraint */
  name: string;
  /** Pattern to detect (regex string or simple string match) */
  pattern: string;
  /** Whether the pattern is a regex (true) or string match (false) */
  isRegex: boolean;
  /** Action to take when pattern matches */
  action: ConstraintAction;
  /** Why this rule is needed */
  justification: string;
  /** Severity level */
  severity: ConstraintSeverity;
  /** Current status */
  status: ProposalStatus;
  /** When proposed */
  proposedAt: string;
  /** When reviewed */
  reviewedAt?: string;
  /** Rejection reason (if rejected) */
  rejectionReason?: string;
}

export interface ActiveConstraint {
  /** Constraint ID (same as approved proposal ID) */
  id: string;
  /** Pattern to detect */
  pattern: string;
  /** Whether regex */
  isRegex: boolean;
  /** Action to take */
  action: ConstraintAction;
  /** Severity */
  severity: ConstraintSeverity;
  /** Name */
  name: string;
  /** Justification */
  justification: string;
  /** When approved */
  approvedAt: string;
  /** Times triggered */
  triggerCount: number;
  /** Last triggered */
  lastTriggeredAt?: string;
}

export interface ActionRecord {
  /** What action was taken */
  action: string;
  /** Tool or system involved */
  source: string;
  /** Parameters of the action */
  params?: Record<string, unknown>;
  /** Output/result of the action */
  output?: string;
  /** Whether the action was blocked */
  blocked: boolean;
  /** What blocked it (if blocked) */
  blockedBy?: string;
  /** Guard results (if from truth-binding) */
  guardResults?: GuardResult[];
  /** Simulation results (if from capability-tiers) */
  simulationResult?: SimulationResult;
  /** Timestamp */
  timestamp: string;
  /** Session ID */
  sessionId?: string;
}

export interface SelfConstraintsConfig {
  /** Root directory for data files */
  dataDir: string;
  /** Maximum proposals to keep */
  maxProposals?: number;
  /** Logger instance (optional) */
  logger?: Logger;
}

// ─── Predefined Constraint Templates ─────────────────────────────────────────

const NEAR_MISS_CONSTRAINT_TEMPLATES: Record<NearMissType, Omit<ConstraintProposal, 'id' | 'nearMissId' | 'status' | 'proposedAt'>> = {
  'secret-leak': {
    name: 'Block API key patterns in responses',
    pattern: '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[A-Z0-9]{16}|AIza[a-zA-Z0-9_-]{35})',
    isRegex: true,
    action: 'block',
    severity: 'critical',
    justification: 'API keys and tokens must never appear in responses. This constraint enforces redaction before any output is sent to the user.',
  },
  'dangerous-command': {
    name: 'Block dangerous shell command patterns',
    pattern: '(rm\\s+-rf\\s+/(?!tmp)|mkfs|dd\\s+if=.*of=/dev/|:\\(\\)\\s*\\{\\s*:|:\\|\\s*&\\s*\\};:|chmod\\s+777\\s+/)',
    isRegex: true,
    action: 'block',
    severity: 'critical',
    justification: 'Destructive shell commands (fork bombs, recursive root deletion, device overwrites) must be blocked before execution.',
  },
  'unverified-claim': {
    name: 'Flag unverified factual claims',
    pattern: '(version\\s+\\d+\\.\\d+|\\d+\\s*(?:MB|GB|TB|users?|requests?))',
    isRegex: true,
    action: 'warn',
    severity: 'medium',
    justification: 'Specific factual claims (version numbers, metrics) should be verified against wiki knowledge before being stated confidently.',
  },
  'rate-limit-near': {
    name: 'Warn when approaching rate limits',
    pattern: 'remaining_tokens:\\s*[0-9]{1,3}(?!\\d)',
    isRegex: true,
    action: 'warn',
    severity: 'medium',
    justification: 'When rate limit remaining is low (under 1000 tokens), warn before making large requests that could fail.',
  },
  'wrong-target': {
    name: 'Validate tool target before execution',
    pattern: 'target\\s*[:=]\\s*(?!session:|node:|host:)',
    isRegex: true,
    action: 'warn',
    severity: 'high',
    justification: 'Tool calls with ambiguous targets should be validated before execution to prevent operations on wrong sessions or nodes.',
  },
  'prompt-leak': {
    name: 'Block system prompt fragments in output',
    pattern: '(you are (?:a|an)\\s+(?:AI|assistant|agent|language model)|<tool_call>|<function_call>|<invoke>)',
    isRegex: true,
    action: 'block',
    severity: 'high',
    justification: 'System prompt fragments and tool call artifacts must never appear in user-facing responses.',
  },
  'excessive-hedging': {
    name: 'Warn on excessive hedging language',
    pattern: '\\b(?:I think|I believe|probably|likely|maybe|perhaps|might be|could be)\\b',
    isRegex: true,
    action: 'warn',
    severity: 'low',
    justification: 'Excessive hedging indicates low confidence. Either verify claims and state them confidently, or acknowledge uncertainty explicitly.',
  },
};

// ─── Self Constraints System ─────────────────────────────────────────────────

export class SelfConstraints {
  private nearMisses: NearMissEvent[] = [];
  private proposals: Map<string, ConstraintProposal> = new Map();
  private activeConstraints: Map<string, ActiveConstraint> = new Map();
  private config: SelfConstraintsConfig;
  private logger: Logger;
  private nearMissesFile: string;
  private proposalsFile: string;
  private constraintsFile: string;
  private loaded = false;

  constructor(config: SelfConstraintsConfig) {
    this.config = {
      maxProposals: 100,
      ...config,
    };
    this.logger = config.logger ?? new Logger({ minLevel: 'info' });
    this.nearMissesFile = join(config.dataDir, 'near-misses.json');
    this.proposalsFile = join(config.dataDir, 'constraint-proposals.json');
    this.constraintsFile = join(config.dataDir, 'active-constraints.json');
  }

  /** Initialize by loading existing data */
  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });

    // Load near-misses
    try {
      const data = await readFile(this.nearMissesFile, 'utf-8');
      this.nearMisses = JSON.parse(data);
      this.logger.info(`[SelfConstraints] Loaded ${this.nearMisses.length} near-miss events`);
    } catch {
      await this.saveNearMisses();
    }

    // Load proposals
    try {
      const data = await readFile(this.proposalsFile, 'utf-8');
      const parsed = JSON.parse(data) as ConstraintProposal[];
      for (const p of parsed) {
        this.proposals.set(p.id, p);
      }
      this.logger.info(`[SelfConstraints] Loaded ${this.proposals.size} constraint proposals`);
    } catch {
      await this.saveProposals();
    }

    // Load active constraints
    try {
      const data = await readFile(this.constraintsFile, 'utf-8');
      const parsed = JSON.parse(data) as ActiveConstraint[];
      for (const c of parsed) {
        this.activeConstraints.set(c.id, c);
      }
      this.logger.info(`[SelfConstraints] Loaded ${this.activeConstraints.size} active constraints`);
    } catch {
      await this.saveConstraints();
    }

    this.loaded = true;
  }

  // ─── Near-Miss Recording ────────────────────────────────────────────────

  /**
   * Record a near-miss event.
   */
  recordNearMiss(event: NearMissEvent): void {
    this.nearMisses.push(event);

    // Keep only recent 500 events
    if (this.nearMisses.length > 500) {
      this.nearMisses = this.nearMisses.slice(-500);
    }

    this.logger.warn(`[SelfConstraints] Near-miss recorded: ${event.type}`, {
      severity: event.severity,
      caughtBy: event.caughtBy,
      description: event.description,
    });

    this.saveNearMisses().catch(err => {
      this.logger.warn(`[SelfConstraints] Failed to save near-misses: ${err}`);
    });
  }

  /**
   * Analyze recent actions for near-miss patterns.
   * Returns detected near-miss events (also records them).
   */
  detectNearMisses(recentActions: ActionRecord[]): NearMissEvent[] {
    const detected: NearMissEvent[] = [];
    const now = new Date().toISOString();

    for (const action of recentActions) {
      // 1. Check for secret patterns in output caught by truth-binding
      if (action.guardResults) {
        const secretGuards = action.guardResults.filter(
          g => g.guard === 'url-verification' && g.severity === 'block' && g.message.includes('credential')
        );
        for (const guard of secretGuards) {
          const event: NearMissEvent = {
            id: `nm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'secret-leak',
            description: `Secret pattern detected in output: ${guard.message}`,
            whatAlmostHappened: 'API key or credential could have been leaked to the user',
            caughtBy: action.blockedBy || 'truth-binding',
            guardName: guard.guard,
            triggerContent: guard.trigger,
            timestamp: action.timestamp || now,
            sessionId: action.sessionId,
            severity: 'critical',
            guardResults: action.guardResults,
          };
          detected.push(event);
          this.recordNearMiss(event);
        }

        // 2. Check for prompt-leak in output
        const leakGuards = action.guardResults.filter(
          g => g.guard === 'prompt-leak-redaction' && g.severity === 'block'
        );
        for (const guard of leakGuards) {
          const event: NearMissEvent = {
            id: `nm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'prompt-leak',
            description: `System prompt fragment detected in output: ${guard.message}`,
            whatAlmostHappened: 'Internal system prompt or tool artifacts could have been exposed',
            caughtBy: action.blockedBy || 'truth-binding',
            guardName: guard.guard,
            triggerContent: guard.trigger,
            timestamp: action.timestamp || now,
            sessionId: action.sessionId,
            severity: 'high',
            guardResults: action.guardResults,
          };
          detected.push(event);
          this.recordNearMiss(event);
        }

        // 3. Check for unverified claims
        const claimGuards = action.guardResults.filter(
          g => g.guard === 'claim-grounding' && g.severity === 'warn'
        );
        for (const guard of claimGuards) {
          const event: NearMissEvent = {
            id: `nm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'unverified-claim',
            description: `Unverified factual claim: ${guard.message}`,
            whatAlmostHappened: 'Response may contain inaccurate claims presented as fact',
            caughtBy: action.blockedBy || 'truth-binding',
            guardName: guard.guard,
            triggerContent: guard.trigger,
            timestamp: action.timestamp || now,
            sessionId: action.sessionId,
            severity: 'medium',
            guardResults: action.guardResults,
          };
          detected.push(event);
          this.recordNearMiss(event);
        }
      }

      // 4. Check for dangerous commands caught by capability-tiers
      if (action.simulationResult && !action.simulationResult.approved) {
        const event: NearMissEvent = {
          id: `nm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'dangerous-command',
          description: `Dangerous command blocked: ${action.simulationResult.predictedOutcome}`,
          whatAlmostHappened: action.simulationResult.sideEffects.join('; ') || 'Destructive operation could have been executed',
          caughtBy: action.blockedBy || 'capability-tiers',
          triggerContent: `[REDACTED: command output]`,
          timestamp: action.timestamp || now,
          sessionId: action.sessionId,
          severity: action.simulationResult.riskLevel as ConstraintSeverity,
          simulationResult: action.simulationResult,
        };
        detected.push(event);
        this.recordNearMiss(event);
      }

      // 5. Check for rate-limit near-misses
      if (action.params && typeof action.params.remainingTokens === 'number') {
        const remaining = action.params.remainingTokens as number;
        if (remaining < 1000) {
          const event: NearMissEvent = {
            id: `nm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'rate-limit-near',
            description: `Rate limit nearly exceeded: ${remaining} tokens remaining`,
            whatAlmostHappened: 'Next LLM call could have failed due to rate limiting',
            caughtBy: 'rate-limiter',
            triggerContent: `${remaining} tokens remaining`,
            timestamp: action.timestamp || now,
            sessionId: action.sessionId,
            severity: remaining < 200 ? 'high' : 'medium',
          };
          detected.push(event);
          this.recordNearMiss(event);
        }
      }

      // 6. Check for wrong-target near-misses
      if (action.params && action.params.target && typeof action.params.target === 'string') {
        const target = action.params.target as string;
        const validTargets = ['session:', 'node:', 'host:', 'sandbox', 'gateway'];
        if (!validTargets.some(v => target.startsWith(v))) {
          const event: NearMissEvent = {
            id: `nm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'wrong-target',
            description: `Ambiguous tool target: "${target}"`,
            whatAlmostHappened: 'Tool call may have been directed to the wrong session or node',
            caughtBy: 'manual-check',
            triggerContent: target,
            timestamp: action.timestamp || now,
            sessionId: action.sessionId,
            severity: 'high',
          };
          detected.push(event);
          this.recordNearMiss(event);
        }
      }
    }

    if (detected.length > 0) {
      this.logger.info(`[SelfConstraints] Detected ${detected.length} near-miss(es) from recent actions`);
    }

    return detected;
  }

  // ─── Constraint Proposals ───────────────────────────────────────────────

  /**
   * Propose a new constraint based on a near-miss event.
   */
  proposeConstraint(nearMiss: NearMissEvent): ConstraintProposal {
    const template = NEAR_MISS_CONSTRAINT_TEMPLATES[nearMiss.type];

    const id = `constraint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const proposal: ConstraintProposal = {
      id,
      nearMissId: nearMiss.id,
      name: template?.name || `Constraint for ${nearMiss.type}`,
      pattern: template?.pattern || nearMiss.triggerContent.slice(0, 100),
      isRegex: template?.isRegex ?? false,
      action: template?.action || 'warn',
      justification: template?.justification || `Prevents recurrence of: ${nearMiss.description}`,
      severity: template?.severity || nearMiss.severity,
      status: 'pending',
      proposedAt: new Date().toISOString(),
    };

    this.proposals.set(id, proposal);
    this.evictIfNeeded();
    this.saveProposals().catch(err => {
      this.logger.warn(`[SelfConstraints] Failed to save proposals: ${err}`);
    });

    this.logger.info(`[SelfConstraints] Proposed constraint: ${proposal.name}`, {
      severity: proposal.severity,
      action: proposal.action,
      nearMissType: nearMiss.type,
    });

    return proposal;
  }

  /**
   * Get pending proposals awaiting human review.
   */
  getPendingProposals(): ConstraintProposal[] {
    return Array.from(this.proposals.values())
      .filter(p => p.status === 'pending')
      .sort((a, b) => {
        const severityOrder: Record<ConstraintSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
  }

  /** Get all proposals (including approved/rejected) */
  getAllProposals(): ConstraintProposal[] {
    return Array.from(this.proposals.values())
      .sort((a, b) => new Date(b.proposedAt).getTime() - new Date(a.proposedAt).getTime());
  }

  /**
   * Approve a constraint — adds it to active constraints and BehavioralLearning.
   */
  approveConstraint(id: string): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;

    if (proposal.status !== 'pending') {
      this.logger.warn(`[SelfConstraints] Cannot approve constraint in '${proposal.status}' status`);
      return;
    }

    proposal.status = 'approved';
    proposal.reviewedAt = new Date().toISOString();

    // Create active constraint
    const constraint: ActiveConstraint = {
      id: proposal.id,
      pattern: proposal.pattern,
      isRegex: proposal.isRegex,
      action: proposal.action,
      severity: proposal.severity,
      name: proposal.name,
      justification: proposal.justification,
      approvedAt: new Date().toISOString(),
      triggerCount: 0,
    };

    this.activeConstraints.set(constraint.id, constraint);

    this.saveProposals().catch(err => {
      this.logger.warn(`[SelfConstraints] Failed to save proposals: ${err}`);
    });
    this.saveConstraints().catch(err => {
      this.logger.warn(`[SelfConstraints] Failed to save constraints: ${err}`);
    });

    this.logger.info(`[SelfConstraints] Constraint approved: ${proposal.name}`, {
      constraintId: constraint.id,
      action: constraint.action,
      severity: constraint.severity,
    });
  }

  /**
   * Reject a constraint proposal.
   */
  rejectConstraint(id: string, reason: string): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;

    proposal.status = 'rejected';
    proposal.reviewedAt = new Date().toISOString();
    proposal.rejectionReason = reason;

    this.saveProposals().catch(err => {
      this.logger.warn(`[SelfConstraints] Failed to save proposals: ${err}`);
    });

    this.logger.info(`[SelfConstraints] Constraint rejected: ${proposal.name}`, {
      proposalId: id,
      reason,
    });
  }

  /**
   * Get all approved and currently enforced constraints.
   */
  getActiveConstraints(): ActiveConstraint[] {
    return Array.from(this.activeConstraints.values())
      .sort((a, b) => {
        const severityOrder: Record<ConstraintSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
  }

  /**
   * Check if a given text matches any active constraint.
   * Returns matching constraints and their action.
   */
  checkText(text: string): Array<{ constraint: ActiveConstraint; matched: boolean }> {
    const results: Array<{ constraint: ActiveConstraint; matched: boolean }> = [];

    for (const constraint of this.activeConstraints.values()) {
      let matched = false;
      if (constraint.isRegex) {
        try {
          const regex = new RegExp(constraint.pattern);
          matched = regex.test(text);
        } catch {
          // Invalid regex — skip
          this.logger.warn(`[SelfConstraints] Invalid regex pattern for constraint ${constraint.id}: ${constraint.pattern}`);
        }
      } else {
        matched = text.includes(constraint.pattern);
      }

      if (matched) {
        constraint.triggerCount++;
        constraint.lastTriggeredAt = new Date().toISOString();
        results.push({ constraint, matched: true });
      }
    }

    if (results.length > 0) {
      this.saveConstraints().catch(err => {
        this.logger.warn(`[SelfConstraints] Failed to save constraints: ${err}`);
      });
    }

    return results;
  }

  /** Get a specific proposal */
  getProposal(id: string): ConstraintProposal | undefined {
    return this.proposals.get(id);
  }

  /** Get near-miss history */
  getNearMissHistory(limit?: number): NearMissEvent[] {
    return limit ? this.nearMisses.slice(-limit) : this.nearMisses;
  }

  /** Get statistics */
  getStats(): {
    totalNearMisses: number;
    pendingProposals: number;
    approvedConstraints: number;
    rejectedProposals: number;
    constraintsBySeverity: Record<ConstraintSeverity, number>;
  } {
    const bySeverity: Record<ConstraintSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const c of this.activeConstraints.values()) {
      bySeverity[c.severity]++;
    }

    return {
      totalNearMisses: this.nearMisses.length,
      pendingProposals: Array.from(this.proposals.values()).filter(p => p.status === 'pending').length,
      approvedConstraints: this.activeConstraints.size,
      rejectedProposals: Array.from(this.proposals.values()).filter(p => p.status === 'rejected').length,
      constraintsBySeverity: bySeverity,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    const max = this.config.maxProposals ?? 100;
    if (this.proposals.size <= max) return;

    // Evict oldest rejected/failed proposals first
    const sorted = Array.from(this.proposals.entries())
      .sort(([, a], [, b]) => {
        const statusOrder: Record<ProposalStatus, number> = { rejected: 0, approved: 1, pending: 2 };
        if (statusOrder[a.status] !== statusOrder[b.status]) {
          return statusOrder[a.status] - statusOrder[b.status];
        }
        return new Date(a.proposedAt).getTime() - new Date(b.proposedAt).getTime();
      });

    while (this.proposals.size > max) {
      const [key] = sorted.shift()!;
      this.proposals.delete(key);
    }
  }

  private async saveWithRetry(saveFn: () => Promise<void>, name: string, maxRetries = 2): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await saveFn();
        return;
      } catch (err: unknown) {
        if (attempt === maxRetries) {
          this.logger.warn(`[SelfConstraints] Failed to save ${name} after ${maxRetries + 1} attempts: ${err}`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    }
  }

  private async saveNearMisses(): Promise<void> {
    await this.saveWithRetry(async () => {
      await mkdir(join(this.nearMissesFile, '..'), { recursive: true });
      await writeFile(this.nearMissesFile, JSON.stringify(this.nearMisses, null, 2), 'utf-8');
    }, 'near-misses');
  }

  private async saveProposals(): Promise<void> {
    await this.saveWithRetry(async () => {
      const data = Array.from(this.proposals.values());
      await mkdir(join(this.proposalsFile, '..'), { recursive: true });
      await writeFile(this.proposalsFile, JSON.stringify(data, null, 2), 'utf-8');
    }, 'proposals');
  }

  private async saveConstraints(): Promise<void> {
    await this.saveWithRetry(async () => {
      const data = Array.from(this.activeConstraints.values());
      await mkdir(join(this.constraintsFile, '..'), { recursive: true });
      await writeFile(this.constraintsFile, JSON.stringify(data, null, 2), 'utf-8');
    }, 'constraints');
  }
}
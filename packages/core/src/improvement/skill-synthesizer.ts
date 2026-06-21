/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Skill Synthesizer
 *
 * Watches what tool sequences the agent uses repeatedly, then proposes
 * a new tool that combines them. Like a macro recorder for tool calls.
 *
 * Pattern detection:
 * - Exact match: same tools in same order (min 3 occurrences)
 * - Partial match: same tools but different order
 * - Param pattern: same tools with similar arguments
 *
 * Lifecycle:
 *   RECORD → DETECT → PROPOSE → APPROVE/REJECT
 * Proposals require human approval before a skill tool is generated.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import type { ToolDefinition, ToolParameter } from '../tools/definitions.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  /** Tool ID (e.g., 'wiki-search') */
  toolId: string;
  /** Parameters used in this call */
  params: Record<string, unknown>;
  /** Whether the call succeeded */
  success: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Timestamp */
  timestamp: string;
}

export type PatternMatchType = 'exact' | 'partial' | 'param-pattern';

export interface ToolPattern {
  /** Unique pattern ID */
  id: string;
  /** Tool IDs in the sequence */
  toolSequence: string[];
  /** How many times this pattern was observed */
  occurrenceCount: number;
  /** Type of pattern match */
  matchType: PatternMatchType;
  /** Example parameter sequences (for param-pattern type) */
  exampleParams?: Record<string, unknown>[];
  /** Sessions where this pattern occurred */
  sessionIds: string[];
  /** First observed */
  firstObserved: string;
  /** Last observed */
  lastObserved: string;
  /** Average total duration of the sequence (ms) */
  avgDurationMs: number;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface SkillProposal {
  /** Unique proposal ID */
  id: string;
  /** The pattern that triggered this proposal */
  patternId: string;
  /** Auto-generated skill name (e.g., 'search-and-summarize') */
  skillName: string;
  /** Human-readable description of what the combined tool does */
  description: string;
  /** Merged parameters from constituent tools */
  parameters: ToolParameter[];
  /** TypeScript code template that chains the tools */
  implementation: string;
  /** The tool IDs this skill combines */
  constituentTools: string[];
  /** Current status */
  status: ProposalStatus;
  /** When proposed */
  proposedAt: string;
  /** When approved/rejected */
  reviewedAt?: string;
  /** Rejection reason (if rejected) */
  rejectionReason?: string;
  /** Human-readable rationale for the proposal */
  rationale: string;
}

export interface ApprovalResult {
  success: boolean;
  proposal: SkillProposal | null;
  toolDefinition: ToolDefinition | null;
  message: string;
}

export interface SkillSynthesizerConfig {
  /** Root directory for data files */
  dataDir: string;
  /** Minimum occurrences to consider a pattern (default: 3) */
  minOccurrences?: number;
  /** Minimum tools in a sequence (default: 2) */
  minSequenceLength?: number;
  /** Maximum tools in a sequence (default: 8) */
  maxSequenceLength?: number;
  /** Throttle: minimum ms between pattern checks (default: 60000) */
  patternCheckIntervalMs?: number;
  /** Logger instance (optional — creates one if not provided) */
  logger?: Logger;
}

// ─── Skill Synthesizer ────────────────────────────────────────────────────────

export class SkillSynthesizer {
  private sequences: Map<string, ToolCallRecord[]> = new Map();
  private patterns: Map<string, ToolPattern> = new Map();
  private proposals: Map<string, SkillProposal> = new Map();
  private config: SkillSynthesizerConfig;
  private logger: Logger;
  private sequencesFile: string;
  private patternsFile: string;
  private proposalsFile: string;
  private lastPatternCheck = 0;
  private loaded = false;

  constructor(config: SkillSynthesizerConfig) {
    this.config = {
      minOccurrences: 3,
      minSequenceLength: 2,
      maxSequenceLength: 8,
      patternCheckIntervalMs: 60_000,
      ...config,
    };
    this.logger = config.logger ?? new Logger({ minLevel: 'info' });
    this.sequencesFile = join(config.dataDir, 'tool-sequences.json');
    this.patternsFile = join(config.dataDir, 'tool-patterns.json');
    this.proposalsFile = join(config.dataDir, 'skill-proposals.json');
  }

  /** Initialize by loading existing data */
  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });

    // Load sequences
    try {
      const data = await readFile(this.sequencesFile, 'utf-8');
      const parsed = JSON.parse(data) as Array<{ sessionId: string; calls: ToolCallRecord[] }>;
      for (const entry of parsed) {
        this.sequences.set(entry.sessionId, entry.calls);
      }
      this.logger.info(`[SkillSynthesizer] Loaded ${this.sequences.size} session sequences`);
    } catch {
      await this.saveSequences();
    }

    // Load patterns
    try {
      const data = await readFile(this.patternsFile, 'utf-8');
      const parsed = JSON.parse(data) as ToolPattern[];
      for (const p of parsed) {
        this.patterns.set(p.id, p);
      }
      this.logger.info(`[SkillSynthesizer] Loaded ${this.patterns.size} patterns`);
    } catch {
      await this.savePatterns();
    }

    // Load proposals
    try {
      const data = await readFile(this.proposalsFile, 'utf-8');
      const parsed = JSON.parse(data) as SkillProposal[];
      for (const p of parsed) {
        this.proposals.set(p.id, p);
      }
      this.logger.info(`[SkillSynthesizer] Loaded ${this.proposals.size} proposals`);
    } catch {
      await this.saveProposals();
    }

    this.loaded = true;
  }

  // ─── Recording ──────────────────────────────────────────────────────────

  /**
   * Record a tool call sequence for a session.
   * Appends to the session's sequence and checks for patterns (throttled).
   */
  recordToolSequence(sessionId: string, tools: ToolCallRecord[]): void {
    if (tools.length === 0) return;

    const existing = this.sequences.get(sessionId) || [];
    existing.push(...tools);
    this.sequences.set(sessionId, existing);

    this.logger.debug(`[SkillSynthesizer] Recorded ${tools.length} tool calls for session ${sessionId}`, {
      totalForSession: existing.length,
    });

    // Throttled pattern detection
    const now = Date.now();
    if (now - this.lastPatternCheck >= (this.config.patternCheckIntervalMs ?? 60_000)) {
      this.lastPatternCheck = now;
      this.detectPatterns();
    }

    // Persist asynchronously
    this.saveSequences().catch(err => {
      this.logger.warn(`[SkillSynthesizer] Failed to save sequences: ${err}`);
    });
  }

  // ─── Pattern Detection ─────────────────────────────────────────────────

  /**
   * Analyze recorded sequences for repeating patterns.
   * Returns all detected patterns (also updates internal state).
   */
  detectPatterns(): ToolPattern[] {
    const minOccurrences = this.config.minOccurrences ?? 3;
    const minLen = this.config.minSequenceLength ?? 2;
    const maxLen = this.config.maxSequenceLength ?? 8;

    // Collect all sequences grouped by session
    const sessionSequences: Array<{ sessionId: string; calls: ToolCallRecord[] }> = [];
    for (const [sessionId, calls] of this.sequences) {
      sessionSequences.push({ sessionId, calls });
    }

    // Extract subsequences of varying lengths
    const candidatePatterns: Map<string, ToolPattern> = new Map();

    for (const { sessionId, calls } of sessionSequences) {
      // Slide through the call sequence with a sliding window
      for (let len = minLen; len <= Math.min(maxLen, calls.length); len++) {
        for (let i = 0; i <= calls.length - len; i++) {
          const window = calls.slice(i, i + len);
          const toolIds = window.map(c => c.toolId);

          // Skip if any toolId is empty
          if (toolIds.some(t => !t)) continue;

          // --- Exact match: same tools in same order ---
          const exactKey = toolIds.join('→');
          this.accumulatePattern(candidatePatterns, exactKey, toolIds, window, sessionId, 'exact');

          // --- Partial match: same tools but different order ---
          // Use sorted tool IDs as the key
          const sortedKey = [...toolIds].sort().join('+');
          if (new Set(toolIds).size === toolIds.length) {
            // Only track partial if different from exact (i.e., not already sorted)
            if (sortedKey !== exactKey) {
              this.accumulatePattern(candidatePatterns, sortedKey, toolIds, window, sessionId, 'partial');
            }
          }

          // --- Param pattern: same tools with similar arguments ---
          // Group by tool IDs and check if params are similar across occurrences
          const paramKey = toolIds.join('→') + ':params';
          // We handle param patterns separately below
        }
      }
    }

    // Now check for param-pattern matches (same tools, similar args)
    this.detectParamPatterns(candidatePatterns, sessionSequences, minLen, maxLen);

    // Filter by minimum occurrences and merge with existing patterns
    const newPatterns: ToolPattern[] = [];
    for (const [key, pattern] of candidatePatterns) {
      if (pattern.occurrenceCount >= minOccurrences) {
        const existing = this.patterns.get(key);
        if (existing) {
          // Update existing pattern
          existing.occurrenceCount = pattern.occurrenceCount;
          existing.lastObserved = pattern.lastObserved;
          existing.avgDurationMs = pattern.avgDurationMs;
          existing.sessionIds = [...new Set([...existing.sessionIds, ...pattern.sessionIds])];
        } else {
          pattern.id = key;
          this.patterns.set(key, pattern);
          newPatterns.push(pattern);
        }
      }
    }

    if (newPatterns.length > 0) {
      this.logger.info(`[SkillSynthesizer] Detected ${newPatterns.length} new pattern(s)`, {
        patterns: newPatterns.map(p => `${p.toolSequence.join('→')} (${p.occurrenceCount}x, ${p.matchType})`),
      });
      this.savePatterns().catch(err => {
        this.logger.warn(`[SkillSynthesizer] Failed to save patterns: ${err}`);
      });
    }

    return Array.from(this.patterns.values()).filter(p => p.occurrenceCount >= minOccurrences);
  }

  // ─── Proposals ──────────────────────────────────────────────────────────

  /**
   * Generate a proposed new tool definition from a pattern.
   */
  proposeSkill(pattern: ToolPattern): SkillProposal {
    const skillName = this.generateSkillName(pattern.toolSequence);
    const description = this.generateDescription(pattern);
    const parameters = this.mergeParameters(pattern);
    const implementation = this.generateImplementation(pattern);
    const rationale = `Observed ${pattern.occurrenceCount} occurrences of tools ${pattern.toolSequence.join(' → ')} across ${pattern.sessionIds.length} session(s). Combining into a single skill would reduce tool call overhead and improve response time by ~${Math.round(pattern.avgDurationMs * 0.3)}ms per invocation.`;

    const id = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const proposal: SkillProposal = {
      id,
      patternId: pattern.id,
      skillName,
      description,
      parameters,
      implementation,
      constituentTools: pattern.toolSequence,
      status: 'pending',
      proposedAt: new Date().toISOString(),
      rationale,
    };

    this.proposals.set(id, proposal);
    this.saveProposals().catch(err => {
      this.logger.warn(`[SkillSynthesizer] Failed to save proposals: ${err}`);
    });

    this.logger.info(`[SkillSynthesizer] Proposed skill: ${skillName}`, {
      patternId: pattern.id,
      occurrenceCount: pattern.occurrenceCount,
    });

    return proposal;
  }

  /**
   * Get all pending proposals awaiting human review.
   */
  getProposals(): SkillProposal[] {
    return Array.from(this.proposals.values())
      .filter(p => p.status === 'pending')
      .sort((a, b) => new Date(b.proposedAt).getTime() - new Date(a.proposedAt).getTime());
  }

  /** Get all proposals (including approved/rejected) */
  getAllProposals(): SkillProposal[] {
    return Array.from(this.proposals.values())
      .sort((a, b) => new Date(b.proposedAt).getTime() - new Date(a.proposedAt).getTime());
  }

  /**
   * Human approves a proposal — generates the tool definition.
   */
  approveProposal(id: string): ApprovalResult {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      return { success: false, proposal: null, toolDefinition: null, message: `Proposal ${id} not found` };
    }

    if (proposal.status !== 'pending') {
      return {
        success: false,
        proposal,
        toolDefinition: null,
        message: `Proposal is already ${proposal.status}`,
      };
    }

    proposal.status = 'approved';
    proposal.reviewedAt = new Date().toISOString();

    // Generate the tool definition
    const toolDefinition: ToolDefinition = {
      id: proposal.skillName,
      name: this.toTitleCase(proposal.skillName.replace(/-/g, ' ')),
      description: proposal.description,
      parameters: proposal.parameters,
      sideEffects: true,
      requiresApproval: false,
      timeout: 30_000,
    };

    this.saveProposals().catch(err => {
      this.logger.warn(`[SkillSynthesizer] Failed to save proposals: ${err}`);
    });

    this.logger.info(`[SkillSynthesizer] Approved skill: ${proposal.skillName}`, {
      proposalId: id,
    });

    return {
      success: true,
      proposal,
      toolDefinition,
      message: `Skill "${proposal.skillName}" approved and tool definition generated`,
    };
  }

  /**
   * Human rejects a proposal.
   */
  rejectProposal(id: string, reason: string): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;

    proposal.status = 'rejected';
    proposal.reviewedAt = new Date().toISOString();
    proposal.rejectionReason = reason;

    this.saveProposals().catch(err => {
      this.logger.warn(`[SkillSynthesizer] Failed to save proposals: ${err}`);
    });

    this.logger.info(`[SkillSynthesizer] Rejected skill: ${proposal.skillName}`, {
      proposalId: id,
      reason,
    });
  }

  /** Get a specific proposal */
  getProposal(id: string): SkillProposal | undefined {
    return this.proposals.get(id);
  }

  /** Get statistics */
  getStats(): {
    totalSequences: number;
    totalPatterns: number;
    pendingProposals: number;
    approvedProposals: number;
    rejectedProposals: number;
  } {
    return {
      totalSequences: this.sequences.size,
      totalPatterns: this.patterns.size,
      pendingProposals: Array.from(this.proposals.values()).filter(p => p.status === 'pending').length,
      approvedProposals: Array.from(this.proposals.values()).filter(p => p.status === 'approved').length,
      rejectedProposals: Array.from(this.proposals.values()).filter(p => p.status === 'rejected').length,
    };
  }

  // ─── Private: Pattern Detection Helpers ─────────────────────────────────

  private accumulatePattern(
    candidates: Map<string, ToolPattern>,
    key: string,
    toolIds: string[],
    window: ToolCallRecord[],
    sessionId: string,
    matchType: PatternMatchType
  ): void {
    const existing = candidates.get(key);
    const now = new Date().toISOString();
    const totalDuration = window.reduce((sum, c) => sum + c.durationMs, 0);

    if (existing) {
      existing.occurrenceCount++;
      existing.sessionIds = [...new Set([...existing.sessionIds, sessionId])];
      existing.lastObserved = now;
      existing.avgDurationMs = Math.round(
        (existing.avgDurationMs * (existing.occurrenceCount - 1) + totalDuration) / existing.occurrenceCount
      );
    } else {
      candidates.set(key, {
        id: key, // Will be set properly if it passes the threshold
        toolSequence: toolIds,
        occurrenceCount: 1,
        matchType,
        sessionIds: [sessionId],
        firstObserved: window[0]?.timestamp || now,
        lastObserved: now,
        avgDurationMs: totalDuration,
      });
    }
  }

  private detectParamPatterns(
    candidates: Map<string, ToolPattern>,
    sessionSequences: Array<{ sessionId: string; calls: ToolCallRecord[] }>,
    minLen: number,
    maxLen: number
  ): void {
    // Group subsequences by tool IDs and check param similarity
    const byToolKey: Map<string, Array<{ window: ToolCallRecord[]; sessionId: string }>> = new Map();

    for (const { sessionId, calls } of sessionSequences) {
      for (let len = minLen; len <= Math.min(maxLen, calls.length); len++) {
        for (let i = 0; i <= calls.length - len; i++) {
          const window = calls.slice(i, i + len);
          const toolIds = window.map(c => c.toolId);
          if (toolIds.some(t => !t)) continue;
          const key = toolIds.join('→');
          const arr = byToolKey.get(key) || [];
          arr.push({ window, sessionId });
          byToolKey.set(key, arr);
        }
      }
    }

    // For each group with enough occurrences, check param similarity
    for (const [key, windows] of byToolKey) {
      if (windows.length < (this.config.minOccurrences ?? 3)) continue;

      // Check if params are similar across occurrences
      const firstWindow = windows[0].window;
      const allParamsSimilar = firstWindow.every((call, callIdx) => {
        const paramsByCall = windows.map(w => w.window[callIdx]?.params);
        return this.areParamsSimilar(paramsByCall);
      });

      if (allParamsSimilar) {
        // Collect example params
        const exampleParams = firstWindow.map(c => c.params);

        const existing = candidates.get(key + ':params');
        const now = new Date().toISOString();
        const totalDuration = firstWindow.reduce((sum, c) => sum + c.durationMs, 0);

        if (existing) {
          existing.occurrenceCount = windows.length;
          existing.exampleParams = exampleParams;
        } else {
          candidates.set(key + ':params', {
            id: key + ':params',
            toolSequence: firstWindow.map(c => c.toolId),
            occurrenceCount: windows.length,
            matchType: 'param-pattern',
            exampleParams,
            sessionIds: windows.map(w => w.sessionId),
            firstObserved: firstWindow[0]?.timestamp || now,
            lastObserved: now,
            avgDurationMs: totalDuration,
          });
        }
      }
    }
  }

  private areParamsSimilar(paramsList: (Record<string, unknown> | undefined)[]): boolean {
    if (paramsList.length < 2) return true;
    const first = paramsList[0];
    if (!first) return false;

    for (let i = 1; i < paramsList.length; i++) {
      const current = paramsList[i];
      if (!current) return false;
      // Check that the same keys exist with similar types
      const firstKeys = Object.keys(first).sort();
      const currKeys = Object.keys(current).sort();
      if (firstKeys.join(',') !== currKeys.join(',')) return false;

      // Check value types match
      for (const key of firstKeys) {
        if (typeof first[key] !== typeof current[key]) return false;
      }
    }
    return true;
  }

  // ─── Private: Proposal Generation ───────────────────────────────────────

  private generateSkillName(toolIds: string[]): string {
    // Combine tool names into a skill name
    // e.g., ['wiki-search', 'wiki-resolve'] → 'search-and-resolve'
    // e.g., ['memory-store', 'decision-log'] → 'store-and-log'
    const parts = toolIds.map(id => {
      // Strip namespace prefix (e.g., 'wiki-' from 'wiki-search')
      const parts = id.split('-');
      // Use the last meaningful part, or the full name if single part
      return parts.length > 1 ? parts.slice(-1)[0] : id;
    });

    // Deduplicate consecutive parts
    const deduped: string[] = [];
    for (const part of parts) {
      if (deduped[deduped.length - 1] !== part) {
        deduped.push(part);
      }
    }

    // Join with 'and' for 2 parts, or use the sequence
    if (deduped.length === 2) {
      return `${deduped[0]}-and-${deduped[1]}`;
    } else if (deduped.length === 3) {
      return `${deduped[0]}-${deduped[1]}-${deduped[2]}`;
    } else {
      return deduped.slice(0, 3).join('-');
    }
  }

  private generateDescription(pattern: ToolPattern): string {
    const tools = pattern.toolSequence;
    const actions = tools.map(t => {
      // Convert tool ID to a verb phrase
      const parts = t.split('-');
      if (parts.length >= 2) {
        return `${parts[0]} ${parts.slice(1).join(' ')}`;
      }
      return `use ${t}`;
    });

    if (tools.length === 2) {
      return `Combined skill: ${actions[0]} and then ${actions[1]}. Replaces a common ${tools.length}-step tool sequence (observed ${pattern.occurrenceCount} times).`;
    } else {
      return `Combined skill: ${actions.slice(0, -1).join(', ')}, then ${actions[actions.length - 1]}. Replaces a ${tools.length}-step tool sequence (observed ${pattern.occurrenceCount} times).`;
    }
  }

  private mergeParameters(pattern: ToolPattern): ToolParameter[] {
    // Create merged parameters from the constituent tools
    const params: ToolParameter[] = [];
    const seenNames = new Set<string>();

    // We can't access the actual tool definitions here, but we can infer
    // parameters from the recorded call params
    if (pattern.exampleParams) {
      for (let i = 0; i < pattern.exampleParams.length; i++) {
        const callParams = pattern.exampleParams[i];
        const toolId = pattern.toolSequence[i];
        for (const [key, value] of Object.entries(callParams)) {
          const paramName = `${toolId.split('-')[0]}_${key}`;
          if (!seenNames.has(paramName)) {
            seenNames.add(paramName);
            params.push({
              name: paramName,
              description: `Parameter '${key}' for tool '${toolId}'`,
              type: this.inferType(value),
              required: false,
            });
          }
        }
      }
    }

    // If no params were inferred, add a generic one
    if (params.length === 0) {
      params.push({
        name: 'query',
        description: 'Primary input for the combined skill',
        type: 'string',
        required: true,
      });
    }

    return params;
  }

  private inferType(value: unknown): ToolParameter['type'] {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object' && value !== null) return 'object';
    return 'string';
  }

  private generateImplementation(pattern: ToolPattern): string {
    const tools = pattern.toolSequence;
    const steps = tools.map((toolId, idx) => {
      const stepVar = `result${idx}`;
      if (idx === 0) {
        return `  // Step ${idx + 1}: Call ${toolId}
  const ${stepVar} = await context.tools.execute('${toolId}', params, context);`;
      } else {
        const prevVar = `result${idx - 1}`;
        return `  // Step ${idx + 1}: Call ${toolId} with output from previous step
  const ${stepVar} = await context.tools.execute('${toolId}', {
    ...params,
    previousResult: ${prevVar}.data,
  }, context);`;
      }
    });

    const lastVar = `result${tools.length - 1}`;

    return `/**
 * Combined skill: ${pattern.toolSequence.join(' → ')}
 * Auto-generated from observed tool patterns (${pattern.occurrenceCount} occurrences)
 */
async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
${steps.join('\n')}
  return {
    success: ${lastVar}.success,
    data: ${lastVar}.data,
    summary: \`Executed ${tools.length}-step sequence: ${tools.join(' → ')}\`,
    durationMs: 0,
    includeInContext: true,
  };
}`;
  }

  private toTitleCase(s: string): string {
    return s.replace(/\b\w/g, c => c.toUpperCase());
  }

  // ─── Private: Persistence ────────────────────────────────────────────────

  private async saveWithRetry(saveFn: () => Promise<void>, name: string, maxRetries = 2): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await saveFn();
        return;
      } catch (err: unknown) {
        if (attempt === maxRetries) {
          this.logger.warn(`[SkillSynthesizer] Failed to save ${name} after ${maxRetries + 1} attempts: ${err}`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    }
  }

  private async saveSequences(): Promise<void> {
    await this.saveWithRetry(async () => {
      const data = Array.from(this.sequences.entries()).map(([sessionId, calls]) => ({ sessionId, calls }));
      await mkdir(join(this.sequencesFile, '..'), { recursive: true });
      await writeFile(this.sequencesFile, JSON.stringify(data, null, 2), 'utf-8');
    }, 'sequences');
  }

  private async savePatterns(): Promise<void> {
    await this.saveWithRetry(async () => {
      const data = Array.from(this.patterns.values());
      await mkdir(join(this.patternsFile, '..'), { recursive: true });
      await writeFile(this.patternsFile, JSON.stringify(data, null, 2), 'utf-8');
    }, 'patterns');
  }

  private async saveProposals(): Promise<void> {
    await this.saveWithRetry(async () => {
      const data = Array.from(this.proposals.values());
      await mkdir(join(this.proposalsFile, '..'), { recursive: true });
      await writeFile(this.proposalsFile, JSON.stringify(data, null, 2), 'utf-8');
    }, 'proposals');
  }
}
/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Dream Mode
 *
 * During idle time, the agent replays past conversations, identifies
 * mistakes, and updates its own rules. Like memory consolidation during sleep.
 *
 * Process:
 * 1. Select recent conversations from SessionManager (last 24h or configurable)
 * 2. For each conversation, replay through current safety rules and behavioral learning
 * 3. Score past responses against current rules (would I say something different now?)
 * 4. Extract learnings: "I was too verbose here", "I missed a safety check there"
 * 5. Propose rule updates via SelfPatching (with human approval)
 * 6. Generate a DreamReport
 *
 * No LLM required — all analysis is deterministic pattern matching.
 */

import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import type { SessionManager, Session, SessionMessage } from '../session/manager.js';
import type { BehavioralLearning, BehavioralRule } from '../safety/behavioral-learning.js';
import type { SelfPatching } from './self-patching.js';
import type { Logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DreamModeConfig {
  /** Data directory for dream reports */
  dataDir: string;
  /** Session manager to pull conversations from */
  sessionManager: SessionManager;
  /** Behavioral learning system for rule evaluation */
  behavioralLearning: BehavioralLearning;
  /** Self-patching system for proposing rule updates */
  selfPatching?: SelfPatching;
  /** Logger */
  logger: Logger;
  /** How far back to look for conversations (ms, default 24h) */
  lookbackMs?: number;
  /** Maximum conversations to review per dream session (default 20) */
  maxConversationsPerSession?: number;
  /** Maximum responses to score per conversation (default 50) */
  maxResponsesPerConversation?: number;
  /** Minimum response length to evaluate (chars, default 20) */
  minResponseLength?: number;
}

export interface DreamReport {
  /** When this dream session ran */
  timestamp: string;
  /** How long the dream session took */
  durationMs: number;
  /** Sessions reviewed */
  sessionsReviewed: number;
  /** Total responses scored */
  responsesScored: number;
  /** Learnings extracted */
  learnings: DreamLearning[];
  /** Rule proposals generated */
  ruleProposals: DreamRuleProposal[];
  /** Summary statistics */
  stats: DreamStats;
}

export interface DreamLearning {
  /** Type of learning */
  type: 'verbosity' | 'safety-miss' | 'correction-pattern' | 'missed-context' | 'rule-violation' | 'good-response';
  /** Session where the learning was found */
  sessionId: string;
  /** Message index in the session */
  messageIndex: number;
  /** What the agent said */
  response: string;
  /** What the learning is */
  learning: string;
  /** Severity: how important this learning is (0-1) */
  severity: number;
  /** Which rule this relates to (if any) */
  ruleId?: string;
}

export interface DreamRuleProposal {
  /** Rule type */
  type: 'new-rule' | 'update-rule' | 'deactivate-rule';
  /** What triggered this proposal */
  trigger: string;
  /** Proposed rule text */
  proposedRule: string;
  /** Existing rule ID (for updates/deactivations) */
  existingRuleId?: string;
  /** Confidence in this proposal (0-1) */
  confidence: number;
  /** Learnings that support this proposal */
  supportingLearnings: string[];
}

export interface DreamStats {
  /** Average response score (0-1, higher is better) */
  avgScore: number;
  /** Responses that would be different now */
  wouldChangeCount: number;
  /** Responses that still hold up */
  wouldKeepCount: number;
  /** Learnings by type */
  learningsByType: Record<string, number>;
  /** Rule proposals by type */
  proposalsByType: Record<string, number>;
}

// ─── Scoring Helpers ─────────────────────────────────────────────────────────

interface ResponseScore {
  score: number; // 0-1, higher = better
  issues: string[];
  wouldChange: boolean;
}

// ─── Dream Mode ─────────────────────────────────────────────────────────────

export class DreamMode {
  private config: {
    dataDir: string;
    sessionManager: SessionManager;
    behavioralLearning: BehavioralLearning;
    selfPatching: SelfPatching | undefined;
    logger: Logger;
    lookbackMs: number;
    maxConversationsPerSession: number;
    maxResponsesPerConversation: number;
    minResponseLength: number;
  };
  private lastDreamAt: string | null = null;
  private dreamHistory: DreamReport[] = [];
  private historyPath: string;

  constructor(config: DreamModeConfig) {
    this.config = {
      dataDir: config.dataDir,
      sessionManager: config.sessionManager,
      behavioralLearning: config.behavioralLearning,
      selfPatching: config.selfPatching,
      logger: config.logger,
      lookbackMs: config.lookbackMs ?? 24 * 60 * 60 * 1000, // 24h
      maxConversationsPerSession: config.maxConversationsPerSession ?? 20,
      maxResponsesPerConversation: config.maxResponsesPerConversation ?? 50,
      minResponseLength: config.minResponseLength ?? 20,
    };

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
    } catch { /* exists */ }

    this.historyPath = join(this.config.dataDir, 'dream-reports.json');
  }

  /** Initialize by loading dream history */
  async init(): Promise<void> {
    if (existsSync(this.historyPath)) {
      try {
        this.dreamHistory = JSON.parse(readFileSync(this.historyPath, 'utf-8'));
        this.config.logger.info(`[dream-mode] Loaded ${this.dreamHistory.length} dream reports`);
      } catch {
        this.dreamHistory = [];
      }
    }
  }

  /**
   * Run a dream session.
   * Selects recent conversations, replays them through current rules,
   * extracts learnings, and proposes rule updates.
   */
  async runDreamSession(): Promise<DreamReport> {
    const startTime = Date.now();
    this.config.logger.info('[dream-mode] Starting dream session...');

    const learnings: DreamLearning[] = [];
    const ruleProposals: DreamRuleProposal[] = [];
    let responsesScored = 0;
    let totalScore = 0;
    let wouldChangeCount = 0;
    let wouldKeepCount = 0;

    // 1. Select recent sessions
    const recentSessions = this.selectRecentSessions();

    if (recentSessions.length === 0) {
      this.config.logger.info('[dream-mode] No recent sessions to review');
      const report: DreamReport = {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        sessionsReviewed: 0,
        responsesScored: 0,
        learnings: [],
        ruleProposals: [],
        stats: {
          avgScore: 0,
          wouldChangeCount: 0,
          wouldKeepCount: 0,
          learningsByType: {},
          proposalsByType: {},
        },
      };
      this.saveReport(report);
      return report;
    }

    // 2. Get current behavioral rules
    const currentRules = this.config.behavioralLearning.getActiveRules();

    // 3. Review each session
    for (const session of recentSessions) {
      const sessionLearnings = this.reviewSession(session, currentRules);

      for (const learning of sessionLearnings) {
        learnings.push(learning);

        if (learning.type === 'good-response') {
          wouldKeepCount++;
        } else {
          wouldChangeCount++;
        }
      }

      // Count responses scored
      const assistantMessages = session.messages
        .filter(m => m.role === 'assistant' && m.content.length >= this.config.minResponseLength)
        .slice(0, this.config.maxResponsesPerConversation);
      responsesScored += assistantMessages.length;

      // Accumulate scores from learnings (severity is inverted: high severity = low score)
      for (const l of sessionLearnings) {
        if (l.type === 'good-response') {
          totalScore += 1;
        } else {
          totalScore += 1 - l.severity;
        }
      }
    }

    // 4. Aggregate learnings into rule proposals
    const aggregatedProposals = this.aggregateLearningsIntoProposals(learnings, currentRules);
    ruleProposals.push(...aggregatedProposals);

    // 5. Submit proposals via SelfPatching if available
    if (this.config.selfPatching && ruleProposals.length > 0) {
      for (const proposal of ruleProposals) {
        if (proposal.type === 'new-rule' && proposal.confidence >= 0.6) {
          try {
            await this.config.selfPatching.propose(
              `Add behavioral rule: ${proposal.proposedRule}`,
              `Discovered during dream mode: ${proposal.trigger}`,
              'safety/behavioral-learning.ts', // target the rules file conceptually
              '', // no old content — this is a conceptual proposal
              `// Rule: ${proposal.proposedRule}`,
              'sleep-cycle',
              ['dream-mode', 'behavioral-rule'],
            );
            this.config.logger.debug(`[dream-mode] Submitted rule proposal: ${proposal.proposedRule}`);
          } catch (err) {
            this.config.logger.warn(`[dream-mode] Failed to submit rule proposal`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // 6. Build stats
    const avgScore = responsesScored > 0 ? totalScore / responsesScored : 0;
    const learningsByType: Record<string, number> = {};
    const proposalsByType: Record<string, number> = {};
    for (const l of learnings) {
      learningsByType[l.type] = (learningsByType[l.type] || 0) + 1;
    }
    for (const p of ruleProposals) {
      proposalsByType[p.type] = (proposalsByType[p.type] || 0) + 1;
    }

    const report: DreamReport = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      sessionsReviewed: recentSessions.length,
      responsesScored,
      learnings,
      ruleProposals,
      stats: {
        avgScore,
        wouldChangeCount,
        wouldKeepCount,
        learningsByType,
        proposalsByType,
      },
    };

    this.lastDreamAt = report.timestamp;
    this.saveReport(report);

    this.config.logger.info(`[dream-mode] Dream session complete`, {
      sessionsReviewed: report.sessionsReviewed,
      responsesScored,
      learnings: learnings.length,
      ruleProposals: ruleProposals.length,
      avgScore: avgScore.toFixed(3),
      durationMs: report.durationMs,
    });

    return report;
  }

  /**
   * Schedule recurring dream sessions.
   * @param intervalMs How often to dream (default 6h)
   * @returns A cleanup function to cancel the schedule
   */
  scheduleDream(intervalMs: number = 6 * 60 * 60 * 1000): () => void {
    this.config.logger.info(`[dream-mode] Scheduling dream sessions every ${intervalMs}ms`);

    const timer = setInterval(async () => {
      try {
        await this.runDreamSession();
      } catch (err) {
        this.config.logger.error(`[dream-mode] Scheduled dream session failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, intervalMs);

    // Don't keep the process alive just for dreaming
    if (timer.unref) {
      timer.unref();
    }

    return () => {
      clearInterval(timer);
      this.config.logger.info('[dream-mode] Dream schedule cancelled');
    };
  }

  /** Get recent dream reports */
  getRecentDreams(limit: number = 10): DreamReport[] {
    return this.dreamHistory.slice(-limit).reverse();
  }

  /** Get the last dream report */
  getLastDream(): DreamReport | null {
    return this.dreamHistory.length > 0
      ? this.dreamHistory[this.dreamHistory.length - 1]
      : null;
  }

  // ─── Private: Session Selection ──────────────────────────────────────────

  private selectRecentSessions(): Session[] {
    const cutoff = Date.now() - this.config.lookbackMs;
    const allSessions = this.config.sessionManager.list();

    return allSessions
      .filter(s => new Date(s.updatedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, this.config.maxConversationsPerSession);
  }

  // ─── Private: Session Review ─────────────────────────────────────────────

  private reviewSession(session: Session, currentRules: BehavioralRule[]): DreamLearning[] {
    const learnings: DreamLearning[] = [];

    const assistantMessages = session.messages
      .filter(m => m.role === 'assistant' && m.content.length >= this.config.minResponseLength)
      .slice(0, this.config.maxResponsesPerConversation);

    for (let i = 0; i < assistantMessages.length; i++) {
      const msg = assistantMessages[i];
      const messageIndex = session.messages.indexOf(msg);

      // Get the preceding user message for context
      const precedingUserMsg = this.findPrecedingUserMessage(session, messageIndex);

      // Score the response against current rules
      const score = this.scoreResponse(msg.content, precedingUserMsg, currentRules);

      if (score.wouldChange) {
        for (const issue of score.issues) {
          const learning = this.extractLearning(issue, msg.content, session.id, messageIndex, currentRules);
          if (learning) {
            learnings.push(learning);
          }
        }
      } else {
        // Good response — reinforce
        learnings.push({
          type: 'good-response',
          sessionId: session.id,
          messageIndex,
          response: msg.content.slice(0, 200),
          learning: 'Response aligns with current rules',
          severity: 0,
        });
      }

      // Check for correction patterns (user corrected after this response)
      const followingUserMsg = this.findFollowingUserMessage(session, messageIndex);
      if (followingUserMsg) {
        const correctionCheck = this.config.behavioralLearning.detectCorrection({
          message: followingUserMsg.content,
          precedingResponse: msg.content,
        });

        if (correctionCheck.isCorrection) {
          learnings.push({
            type: 'correction-pattern',
            sessionId: session.id,
            messageIndex,
            response: msg.content.slice(0, 200),
            learning: `User corrected this response: "${followingUserMsg.content.slice(0, 100)}"`,
            severity: correctionCheck.confidence,
          });
        }
      }
    }

    return learnings;
  }

  // ─── Private: Response Scoring ─────────────────────────────────────────────

  private scoreResponse(
    response: string,
    precedingUserMessage: SessionMessage | null,
    currentRules: BehavioralRule[]
  ): ResponseScore {
    const issues: string[] = [];
    let score = 1.0;

    // Check against each active behavioral rule
    for (const rule of currentRules) {
      const violation = this.checkRuleViolation(response, precedingUserMessage, rule);
      if (violation) {
        issues.push(violation);
        score -= rule.confidence * 0.3; // Deduct based on rule confidence
      }
    }

    // Check verbosity (too long without reason)
    if (response.length > 2000 && !response.includes('```')) {
      const words = response.split(/\s+/).length;
      if (words > 500) {
        issues.push('verbosity: response over 500 words without code blocks');
        score -= 0.2;
      }
    }

    // Check for hedging language (uncertainty)
    const hedgingPatterns = [
      /\b(I think|maybe|perhaps|possibly|I'm not sure|might be|could be|I believe)\b/gi,
    ];
    const hedgingCount = hedgingPatterns.reduce((count, pattern) => {
      const matches = response.match(pattern);
      return count + (matches ? matches.length : 0);
    }, 0);
    if (hedgingCount > 3) {
      issues.push(`verbosity: ${hedgingCount} uncertainty markers in response`);
      score -= 0.15;
    }

    // Check for missed safety keywords
    if (precedingUserMessage) {
      const userText = precedingUserMessage.content.toLowerCase();
      const safetyKeywords = ['password', 'token', 'secret', 'key', 'credential', 'delete', 'remove', 'drop'];
      const hasSafetyKeyword = safetyKeywords.some(kw => userText.includes(kw));
      if (hasSafetyKeyword) {
        const responseLower = response.toLowerCase();
        if (!responseLower.includes('warn') && !responseLower.includes('careful') && !responseLower.includes('confirm')) {
          issues.push('safety-miss: user message contains sensitive keyword but response lacks caution');
          score -= 0.3;
        }
      }
    }

    // Check for response that doesn't address the question
    if (precedingUserMessage && precedingUserMessage.content.includes('?')) {
      const questionWords = precedingUserMessage.content
        .split('?')[0]
        .split(/\s+/)
        .filter(w => w.length > 4);
      const responseLower = response.toLowerCase();
      const overlap = questionWords.filter(w => responseLower.includes(w.toLowerCase()));
      if (overlap.length === 0 && questionWords.length > 3) {
        issues.push('missed-context: response does not share key words with the question');
        score -= 0.2;
      }
    }

    score = Math.max(0, score);
    const wouldChange = score < 0.7;

    return { score, issues, wouldChange };
  }

  // ─── Private: Rule Violation Check ─────────────────────────────────────────

  private checkRuleViolation(
    response: string,
    precedingUserMessage: SessionMessage | null,
    rule: BehavioralRule
  ): string | null {
    // Check if the response contains the incorrect behavior
    if (rule.incorrectBehavior) {
      const incorrectLower = rule.incorrectBehavior.toLowerCase();
      const responseLower = response.toLowerCase();
      if (responseLower.includes(incorrectLower.slice(0, 30))) {
        return `rule-violation: "${rule.incorrectBehavior}" (rule: ${rule.id}) — response contains behavior this rule says to avoid`;
      }
    }

    // Check if the response fails to apply the correct behavior
    if (rule.trigger && precedingUserMessage) {
      const triggerLower = rule.trigger.toLowerCase();
      const userLower = precedingUserMessage.content.toLowerCase();
      // If the trigger matches the user message context
      if (userLower.includes(triggerLower) || this.triggerMatchesContext(triggerLower, userLower)) {
        const correctLower = rule.correctBehavior.toLowerCase();
        const responseLower = response.toLowerCase();
        // Check if at least some keywords from correct behavior appear
        const keywords = correctLower.split(/\s+/).filter(w => w.length > 4);
        const overlap = keywords.filter(kw => responseLower.includes(kw));
        if (overlap.length === 0 && keywords.length > 2) {
          return `rule-violation: rule ${rule.id} trigger "${rule.trigger}" matched but correct behavior "${rule.correctBehavior}" not reflected in response`;
        }
      }
    }

    return null;
  }

  private triggerMatchesContext(trigger: string, context: string): boolean {
    // Simple keyword overlap check
    const triggerWords = new Set(trigger.split(/\s+/).filter(w => w.length > 3));
    const contextWords = new Set(context.split(/\s+/).filter(w => w.length > 3));
    let overlap = 0;
    for (const tw of triggerWords) {
      if (contextWords.has(tw)) overlap++;
    }
    return overlap >= Math.ceil(triggerWords.size * 0.5);
  }

  // ─── Private: Learning Extraction ──────────────────────────────────────────

  private extractLearning(
    issue: string,
    response: string,
    sessionId: string,
    messageIndex: number,
    currentRules: BehavioralRule[]
  ): DreamLearning | null {
    const parts = issue.split(':');
    if (parts.length < 2) return null;

    const type = parts[0].trim() as DreamLearning['type'];
    const detail = parts.slice(1).join(':').trim();

    let severity = 0.5;
    let ruleId: string | undefined;

    switch (type) {
      case 'verbosity':
        // Could be excessive length or excessive hedging — both are verbosity issues
        severity = detail.includes('uncertainty') ? 0.2 : 0.3;
        break;
      case 'safety-miss':
        severity = 0.8;
        break;
      case 'missed-context':
        severity = 0.6;
        break;
      case 'rule-violation': {
        // Extract rule ID if present
        const ruleMatch = detail.match(/rule[:\s]+([a-zA-Z0-9-]+)/i);
        if (ruleMatch) {
          ruleId = ruleMatch[1];
          const rule = currentRules.find(r => r.id === ruleId);
          severity = rule ? rule.confidence * 0.7 : 0.5;
        } else {
          severity = 0.5;
        }
        break;
      }
      default:
        severity = 0.4;
    }

    return {
      type,
      sessionId,
      messageIndex,
      response: response.slice(0, 200),
      learning: detail,
      severity,
      ruleId,
    };
  }

  // ─── Private: Rule Proposal Aggregation ────────────────────────────────────

  private aggregateLearningsIntoProposals(
    learnings: DreamLearning[],
    currentRules: BehavioralRule[]
  ): DreamRuleProposal[] {
    const proposals: DreamRuleProposal[] = [];

    // Group learnings by type
    const byType = new Map<string, DreamLearning[]>();
    for (const l of learnings) {
      if (l.type === 'good-response') continue;
      const group = byType.get(l.type) || [];
      group.push(l);
      byType.set(l.type, group);
    }

    // Verbosity pattern → propose a conciseness rule
    const allVerbosityLearnings = byType.get('verbosity') || [];
    const verboseLearnings = allVerbosityLearnings.filter(l => !l.learning.includes('uncertainty'));
    const hedgingLearnings = allVerbosityLearnings.filter(l => l.learning.includes('uncertainty'));

    if (verboseLearnings.length >= 3) {
      const confidence = Math.min(0.9, 0.5 + verboseLearnings.length * 0.1);
      proposals.push({
        type: 'new-rule',
        trigger: `${verboseLearnings.length} verbose responses detected in dream review`,
        proposedRule: 'When generating responses, keep prose under 500 words unless code blocks are needed',
        confidence,
        supportingLearnings: verboseLearnings.map(l => l.learning),
      });
    }

    // Safety miss pattern → propose a caution rule
    const safetyLearnings = byType.get('safety-miss') || [];
    if (safetyLearnings.length >= 1) {
      const confidence = Math.min(0.95, 0.7 + safetyLearnings.length * 0.1);
      proposals.push({
        type: 'new-rule',
        trigger: `${safetyLearnings.length} safety misses detected in dream review`,
        proposedRule: 'When user message contains sensitive keywords (password, token, secret, delete), include a caution note',
        confidence,
        supportingLearnings: safetyLearnings.map(l => l.learning),
      });
    }

    // Hedging pattern → propose a confidence rule
    if (hedgingLearnings.length >= 3) {
      proposals.push({
        type: 'new-rule',
        trigger: `${hedgingLearnings.length} responses with excessive hedging detected`,
        proposedRule: 'When responding, limit uncertainty markers (I think, maybe, perhaps) to at most 1 per response',
        confidence: Math.min(0.8, 0.4 + hedgingLearnings.length * 0.1),
        supportingLearnings: hedgingLearnings.map(l => l.learning),
      });
    }

    // Missed context pattern → propose a relevance rule
    const contextLearnings = byType.get('missed-context') || [];
    if (contextLearnings.length >= 3) {
      proposals.push({
        type: 'new-rule',
        trigger: `${contextLearnings.length} responses with missed context detected`,
        proposedRule: 'When answering a question, ensure at least one keyword from the question appears in the response',
        confidence: Math.min(0.75, 0.4 + contextLearnings.length * 0.1),
        supportingLearnings: contextLearnings.map(l => l.learning),
      });
    }

    // Correction patterns → propose rules from corrections
    const correctionLearnings = byType.get('correction-pattern') || [];
    if (correctionLearnings.length >= 2) {
      // Check if any existing rules already cover this
      for (const cl of correctionLearnings) {
        const hasExistingRule = currentRules.some(r =>
          cl.learning.toLowerCase().includes(r.correctBehavior.toLowerCase().slice(0, 20))
        );
        if (!hasExistingRule) {
          proposals.push({
            type: 'new-rule',
            trigger: `Repeated corrections detected: ${cl.learning}`,
            proposedRule: `When responding in similar context, avoid the behavior that was corrected: ${cl.learning.slice(0, 100)}`,
            confidence: cl.severity,
            supportingLearnings: [cl.learning],
          });
        }
      }
    }

    // Rule violations → propose strengthening those rules
    const violationLearnings = byType.get('rule-violation') || [];
    for (const vl of violationLearnings) {
      if (vl.ruleId) {
        const existingRule = currentRules.find(r => r.id === vl.ruleId);
        if (existingRule && existingRule.applicationCount < 3) {
          proposals.push({
            type: 'update-rule',
            trigger: `Rule ${vl.ruleId} violated but rarely applied (${existingRule.applicationCount} times)`,
            existingRuleId: vl.ruleId,
            proposedRule: `Increase prominence of rule: "${existingRule.trigger} → ${existingRule.correctBehavior}"`,
            confidence: 0.6,
            supportingLearnings: [vl.learning],
          });
        }
      }
    }

    return proposals;
  }

  // ─── Private: Message Helpers ──────────────────────────────────────────────

  private findPrecedingUserMessage(session: Session, messageIndex: number): SessionMessage | null {
    for (let i = messageIndex - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg && msg.role === 'user' && !msg.toolCallId) {
        return msg;
      }
    }
    return null;
  }

  private findFollowingUserMessage(session: Session, messageIndex: number): SessionMessage | null {
    for (let i = messageIndex + 1; i < session.messages.length; i++) {
      const msg = session.messages[i];
      if (msg && msg.role === 'user' && !msg.toolCallId) {
        return msg;
      }
    }
    return null;
  }

  // ─── Private: Persistence ──────────────────────────────────────────────────

  private saveReport(report: DreamReport): void {
    this.dreamHistory.push(report);

    // Keep last 50 dream reports
    if (this.dreamHistory.length > 50) {
      this.dreamHistory = this.dreamHistory.slice(-50);
    }

    try {
      writeFileSync(this.historyPath, JSON.stringify(this.dreamHistory, null, 2));
    } catch (err) {
      this.config.logger.warn(`[dream-mode] Failed to save dream report`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
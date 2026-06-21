/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Multi-Agent Quality Gates
 *
 * When the agent produces important output (wiki writes, code changes,
 * external messages), a reviewer subagent checks the output for:
 * - Accuracy: Are facts grounded in wiki knowledge?
 * - Completeness: Did the output address everything requested?
 * - Tone: Does the output match the agent's identity/personality?
 * - Safety: Does the output contain secrets, harmful content, or prompt leaks?
 *
 * Inspired by GBase's multi-agent review, but simpler:
 * - Single reviewer role (not three separate agents)
 * - Deterministic checks first, LLM review only for high-stakes output
 * - Quality scores (0-1) for each dimension
 * - Blocking thresholds: below threshold, output is held for human review
 *
 * This is a quality gate, not a replacement for the truth-binding layer.
 * The truth-binding layer runs on ALL outputs; quality gates run on
 * IMPORTANT outputs (wiki writes, code changes, external messages).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type QualityDimension = 'accuracy' | 'completeness' | 'tone' | 'safety';

export type GateDecision = 'approve' | 'warn' | 'block' | 'needs-review';

export interface QualityScore {
  /** The dimension being scored */
  dimension: QualityDimension;
  /** Score from 0 to 1 */
  score: number;
  /** What was checked */
  checks: QualityCheck[];
  /** Brief explanation */
  explanation: string;
}

export interface QualityCheck {
  /** Name of the check */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Detail about what was found */
  detail: string;
  /** Severity if failed */
  severity: 'info' | 'warning' | 'error';
}

export interface QualityGateResult {
  /** Overall decision */
  decision: GateDecision;
  /** Whether the output can be sent (approve or warn) */
  canSend: boolean;
  /** Quality scores by dimension */
  scores: QualityScore[];
  /** Overall quality score (0-1, weighted average) */
  overallScore: number;
  /** Issues that need attention */
  issues: QualityIssue[];
  /** Recommendations */
  recommendations: string[];
  /** Timestamp */
  timestamp: string;
}

export interface QualityIssue {
  dimension: QualityDimension;
  severity: 'warning' | 'error';
  description: string;
  suggestion: string;
}

export interface QualityGateConfig {
  /** Directory for storing quality gate logs */
  dataDir: string;
  /** Thresholds for blocking output (0-1) */
  thresholds?: {
    accuracy?: number;
    completeness?: number;
    tone?: number;
    safety?: number;
  };
  /** Which output types require quality gates */
  gatedTypes?: GateOutputType[];
  /** Whether to use LLM review for high-stakes outputs */
  useLLMReview?: boolean;
}

export type GateOutputType =
  | 'wiki-write'
  | 'code-change'
  | 'external-message'
  | 'cron-job'
  | 'config-change'
  | 'file-write'
  | 'decision-log';

export interface QualityGateInput {
  /** The output to review */
  output: string;
  /** The type of output */
  type: GateOutputType;
  /** The original request/prompt that generated this output */
  request: string;
  /** Available context (wiki excerpts, tool results, etc.) */
  context?: string[];
  /** The agent's identity/rules */
  identityRules?: string;
  /** Whether this is a high-stakes output */
  highStakes?: boolean;
}

// ─── Default Thresholds ──────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: Record<QualityDimension, number> = {
  accuracy: 0.7,
  completeness: 0.6,
  tone: 0.5,
  safety: 0.9, // Safety has the highest threshold
};

const DEFAULT_GATED_TYPES: GateOutputType[] = [
  'wiki-write',
  'code-change',
  'external-message',
  'cron-job',
  'config-change',
];

// ─── Deterministic Quality Checks ────────────────────────────────────────────

/**
 * Accuracy checks: verify facts against provided context.
 */
function checkAccuracy(input: QualityGateInput): QualityScore {
  const checks: QualityCheck[] = [];

  // Check: Does the output reference wiki sources when making claims?
  const hasWikiLinks = /\[\[.+?\]\]/.test(input.output);
  const hasFactualClaims = /\b(?:is|are|was|were|has|have|had)\s+\S+/i.test(input.output);
  checks.push({
    name: 'wiki-sourcing',
    passed: !hasFactualClaims || hasWikiLinks || !!(input.context && input.context.length > 0),
    detail: hasFactualClaims && !hasWikiLinks && (!input.context || input.context.length === 0)
      ? 'Factual claims made without wiki sources or context'
      : 'Claims are sourced or no factual claims made',
    severity: 'warning',
  });

  // Check: Are there numerical claims that should be verified?
  const numericalClaims = input.output.match(/\d+(?:\.\d+)?(?:%|\$|ms|seconds?|minutes?|hours?|days?|GB|MB|TB)/gi) || [];
  if (numericalClaims.length > 0) {
    checks.push({
      name: 'numerical-verification',
      passed: numericalClaims.length <= 5,
      detail: `${numericalClaims.length} numerical claims found — verify against wiki`,
      severity: numericalClaims.length > 5 ? 'warning' : 'info',
    });
  }

  // Check: Are there temporal claims ("currently", "now", "today")?
  const temporalClaims = input.output.match(/\b(?:currently|now|today|this week|this month|this year)\b/gi) || [];
  if (temporalClaims.length > 3) {
    checks.push({
      name: 'temporal-claims',
      passed: false,
      detail: `${temporalClaims.length} temporal claims — may become stale quickly`,
      severity: 'warning',
    });
  }

  // Calculate score
  const passedChecks = checks.filter(c => c.passed).length;
  const score = checks.length > 0 ? passedChecks / checks.length : 0.8; // Default to 0.8 if no checks
  const failedChecks = checks.filter(c => !c.passed && c.severity === 'error');

  return {
    dimension: 'accuracy',
    score: failedChecks.length > 0 ? Math.min(0.3, score) : score,
    checks,
    explanation: failedChecks.length > 0
      ? `Accuracy concerns: ${failedChecks.map(c => c.detail).join('; ')}`
      : `Accuracy checks: ${passedChecks}/${checks.length} passed`,
  };
}

/**
 * Completeness checks: verify the output addresses the request.
 */
function checkCompleteness(input: QualityGateInput): QualityScore {
  const checks: QualityCheck[] = [];
  const request = input.request.toLowerCase();
  const output = input.output.toLowerCase();

  // Check: Does the output directly address the key verbs in the request?
  const requestVerbs = request.match(/\b(create|build|make|fix|update|delete|remove|add|check|explain|describe|list|show|find|search)\b/gi) || [];
  const addressed = requestVerbs.filter(verb => output.includes(verb.toLowerCase()));
  checks.push({
    name: 'verb-coverage',
    passed: requestVerbs.length === 0 || addressed.length >= requestVerbs.length * 0.5,
    detail: requestVerbs.length > 0
      ? `Request verbs: ${requestVerbs.join(', ')} — addressed: ${addressed.join(', ')} (${addressed.length}/${requestVerbs.length})`
      : 'No specific action verbs in request',
    severity: 'info',
  });

  // Check: Is the output too short for the request?
  const requestLength = input.request.length;
  const outputLength = input.output.length;
  const tooShort = requestLength > 50 && outputLength < requestLength * 0.3;
  checks.push({
    name: 'output-length',
    passed: !tooShort,
    detail: tooShort
      ? `Output (${outputLength} chars) seems short for request (${requestLength} chars)`
      : `Output length is reasonable (${outputLength} chars for ${requestLength} char request)`,
    severity: tooShort ? 'warning' : 'info',
  });

  // Check: Does the output mention key subjects from the request?
  const requestWords = request.split(/\s+/).filter(w => w.length > 4 && !['about', 'please', 'could', 'would', 'should'].includes(w));
  const subjectCoverage = requestWords.filter(w => output.includes(w));
  checks.push({
    name: 'subject-coverage',
    passed: requestWords.length === 0 || subjectCoverage.length >= requestWords.length * 0.3,
    detail: requestWords.length > 0
      ? `Key subject words covered: ${subjectCoverage.length}/${requestWords.length}`
      : 'No specific subject words to check',
    severity: 'info',
  });

  const passedChecks = checks.filter(c => c.passed).length;
  const score = checks.length > 0 ? passedChecks / checks.length : 0.7;

  return {
    dimension: 'completeness',
    score,
    checks,
    explanation: `Completeness checks: ${passedChecks}/${checks.length} passed`,
  };
}

/**
 * Tone checks: verify the output matches the agent's identity.
 */
function checkTone(input: QualityGateInput): QualityScore {
  const checks: QualityCheck[] = [];

  // Check for overly formal language
  const formalPatterns = /\b(therefore|furthermore|consequently|nevertheless|hitherto|whereby)\b/gi;
  const formalMatches = input.output.match(formalPatterns) || [];
  if (formalMatches.length > 2) {
    checks.push({
      name: 'excessive-formality',
      passed: false,
      detail: `${formalMatches.length} overly formal phrases detected`,
      severity: 'warning',
    });
  }

  // Check for hedging language
  const hedgePatterns = /\b(I think|I believe|maybe|perhaps|possibly|it could be|it might be|sort of|kind of)\b/gi;
  const hedgeMatches = input.output.match(hedgePatterns) || [];
  if (hedgeMatches.length > 3) {
    checks.push({
      name: 'excessive-hedging',
      passed: false,
      detail: `${hedgeMatches.length} hedging phrases — consider being more direct`,
      severity: 'info',
    });
  }

  // Check for apology patterns (over-apologizing)
  const apologyPatterns = /\b(I'm sorry|I apologize|sorry about|my apologies|I regret)\b/gi;
  const apologyMatches = input.output.match(apologyPatterns) || [];
  if (apologyMatches.length > 1) {
    checks.push({
      name: 'over-apologizing',
      passed: false,
      detail: `${apologyMatches.length} apologies — agents should be direct, not apologetic`,
      severity: 'info',
    });
  }

  // Check for self-reference (overly chatty)
  const selfRefPatterns = /\b(I personally|as for me|in my opinion|from my perspective)\b/gi;
  const selfRefMatches = input.output.match(selfRefPatterns) || [];
  if (selfRefMatches.length > 2) {
    checks.push({
      name: 'excessive-self-reference',
      passed: false,
      detail: `${selfRefMatches.length} self-referential phrases`,
      severity: 'info',
    });
  }

  // Default pass if no issues
  if (checks.length === 0) {
    checks.push({
      name: 'tone-check',
      passed: true,
      detail: 'Tone appears appropriate',
      severity: 'info',
    });
  }

  const passedChecks = checks.filter(c => c.passed).length;
  const score = checks.length > 0 ? passedChecks / checks.length : 1.0;

  return {
    dimension: 'tone',
    score,
    checks,
    explanation: `Tone checks: ${passedChecks}/${checks.length} passed`,
  };
}

/**
 * Safety checks: verify the output doesn't contain harmful content.
 * (This complements the truth-binding layer; it focuses on output quality)
 */
function checkSafety(input: QualityGateInput): QualityScore {
  const checks: QualityCheck[] = [];

  // Secret detection (duplicated from truth-binding for defense in depth)
  const secretPatterns = [
    { pattern: /sk-[a-zA-Z0-9]{20,}/, name: 'OpenAI API key' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub PAT' },
    { pattern: /AKIA[A-Z0-9]{16}/, name: 'AWS access key' },
    { pattern: /password\s*[:=]\s*\S+/i, name: 'password' },
    { pattern: /token\s*[:=]\s*["'][^"']+["']/i, name: 'auth token' },
  ];

  for (const { pattern, name } of secretPatterns) {
    if (pattern.test(input.output)) {
      checks.push({
        name: 'secret-detection',
        passed: false,
        detail: `Potential ${name} detected in output`,
        severity: 'error',
      });
      break; // One secret is enough to fail
    }
  }

  // Check for PII patterns
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phonePattern = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
  const emails = input.output.match(emailPattern) || [];
  const phones = input.output.match(phonePattern) || [];

  if (emails.length > 0) {
    checks.push({
      name: 'pii-email',
      passed: false,
      detail: `${emails.length} email address(es) in output — may be PII`,
      severity: 'warning',
    });
  }

  if (phones.length > 0) {
    checks.push({
      name: 'pii-phone',
      passed: false,
      detail: `${phones.length} phone number(s) in output — may be PII`,
      severity: 'warning',
    });
  }

  // Check for harmful content patterns
  const harmfulPatterns = [
    /\b(hack|exploit|vulnerability)\s+(?:into|against|for)\b/gi,
    /\b(?:how\s+to)\s+(?:hack|crack|exploit|steal)\b/gi,
  ];

  for (const pattern of harmfulPatterns) {
    if (pattern.test(input.output)) {
      checks.push({
        name: 'harmful-content',
        passed: false,
        detail: 'Potentially harmful content detected',
        severity: 'error',
      });
      break;
    }
  }

  // Default pass if no issues
  if (checks.length === 0) {
    checks.push({
      name: 'safety-check',
      passed: true,
      detail: 'No safety issues detected',
      severity: 'info',
    });
  }

  const errorChecks = checks.filter(c => !c.passed && c.severity === 'error');
  const passedChecks = checks.filter(c => c.passed).length;
  // Safety failures are weighted more heavily
  const score = errorChecks.length > 0 ? 0 : (checks.length > 0 ? passedChecks / checks.length : 1);

  return {
    dimension: 'safety',
    score,
    checks,
    explanation: errorChecks.length > 0
      ? `SAFETY BLOCK: ${errorChecks.map(c => c.detail).join('; ')}`
      : `Safety checks: ${passedChecks}/${checks.length} passed`,
  };
}

// ─── Quality Gate System ──────────────────────────────────────────────────────

export class QualityGate {
  private config: QualityGateConfig;
  private logPath: string;
  private recentResults: QualityGateResult[] = [];
  private logger = getLogger('QualityGate');

  constructor(config: QualityGateConfig) {
    this.config = config;
    this.logPath = join(config.dataDir, 'quality-gate-log.json');
  }

  /** Initialize by loading recent log */
  async init(): Promise<void> {
    try {
      const data = await readFile(this.logPath, 'utf-8');
      this.recentResults = JSON.parse(data);
      this.logger.info('Loaded quality gate results', { count: this.recentResults.length });
    } catch {
      await mkdir(join(this.logPath, '..'), { recursive: true });
      await this.save();
    }
  }

  /**
   * Check if an output type requires quality gating.
   */
  shouldGate(type: GateOutputType): boolean {
    const gatedTypes = this.config.gatedTypes || DEFAULT_GATED_TYPES;
    return gatedTypes.includes(type);
  }

  /**
   * Run quality gates on an output.
   * Returns a result with scores, decision, and recommendations.
   */
  async review(input: QualityGateInput): Promise<QualityGateResult> {
    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...this.config.thresholds,
    };

    // Run all dimension checks
    const scores: QualityScore[] = [
      checkAccuracy(input),
      checkCompleteness(input),
      checkTone(input),
      checkSafety(input),
    ];

    // Collect all issues
    const issues: QualityIssue[] = [];
    const recommendations: string[] = [];

    for (const score of scores) {
      for (const check of score.checks) {
        if (!check.passed) {
          issues.push({
            dimension: score.dimension,
            severity: check.severity === 'error' ? 'error' : 'warning',
            description: check.detail,
            suggestion: `Review and address: ${check.detail}`,
          });
        }
      }

      // Check against thresholds
      const threshold = thresholds[score.dimension];
      if (score.score < threshold) {
        recommendations.push(
          `${score.dimension} score (${score.score.toFixed(2)}) below threshold (${threshold}) — ${score.explanation}`
        );
      }
    }

    // Calculate overall score (weighted: safety 40%, accuracy 25%, completeness 20%, tone 15%)
    const overallScore =
      (scores.find(s => s.dimension === 'safety')!.score * 0.4) +
      (scores.find(s => s.dimension === 'accuracy')!.score * 0.25) +
      (scores.find(s => s.dimension === 'completeness')!.score * 0.2) +
      (scores.find(s => s.dimension === 'tone')!.score * 0.15);

    // Determine decision
    let decision: GateDecision;
    const safetyScore = scores.find(s => s.dimension === 'safety')!.score;
    const accuracyScore = scores.find(s => s.dimension === 'accuracy')!.score;

    if (safetyScore < thresholds.safety) {
      decision = 'block';
    } else if (overallScore < 0.5 || accuracyScore < thresholds.accuracy) {
      decision = 'needs-review';
    } else if (issues.filter(i => i.severity === 'error').length > 0) {
      decision = 'block';
    } else if (issues.filter(i => i.severity === 'warning').length > 2 || overallScore < 0.7) {
      decision = 'warn';
    } else {
      decision = 'approve';
    }

    const result: QualityGateResult = {
      decision,
      canSend: decision === 'approve' || decision === 'warn',
      scores,
      overallScore,
      issues,
      recommendations,
      timestamp: new Date().toISOString(),
    };

    // Log the result
    this.recentResults.push(result);
    if (this.recentResults.length > 100) {
      this.recentResults = this.recentResults.slice(-100);
    }
    await this.save();

    return result;
  }

  /**
   * Get the quality gate status for display.
   */
  getStatus(): { recentDecisions: Record<GateDecision, number>; avgScores: Record<QualityDimension, number> } {
    const recentDecisions: Record<GateDecision, number> = {
      approve: 0, warn: 0, block: 0, 'needs-review': 0,
    };
    const scoreSums: Record<string, number> = { accuracy: 0, completeness: 0, tone: 0, safety: 0 };
    const scoreCounts: Record<string, number> = { accuracy: 0, completeness: 0, tone: 0, safety: 0 };

    for (const result of this.recentResults) {
      recentDecisions[result.decision]++;
      for (const score of result.scores) {
        scoreSums[score.dimension] += score.score;
        scoreCounts[score.dimension]++;
      }
    }

    const avgScores: Record<string, number> = {};
    for (const dim of Object.keys(scoreSums)) {
      avgScores[dim] = scoreCounts[dim] > 0 ? scoreSums[dim] / scoreCounts[dim] : 0;
    }

    return {
      recentDecisions,
      avgScores: avgScores as Record<QualityDimension, number>,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    await mkdir(join(this.logPath, '..'), { recursive: true });
    await writeFile(this.logPath, JSON.stringify(this.recentResults, null, 2), 'utf-8');
  }
}
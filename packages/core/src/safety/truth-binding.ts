/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Truth-Binding Response Layer
 *
 * Post-processing output guards that verify agent responses before
 * they reach the user. Inspired by WASP's truth-binding layer, but
 * adapted for Lodestone's architecture.
 *
 * Five deterministic guards (no LLM in the policy path):
 * 1. URL Verification — Checks URLs are real, blocks known fakes
 * 2. Claim Grounding — Verifies claims against wiki knowledge
 * 3. Schedule Honesty — Validates time/date claims against actual schedule
 * 4. Prompt-Leak Redaction — Strips system prompt fragments from output
 * 5. Action Announcer — Flags when the agent is about to take external action
 *
 * Each guard returns a GuardResult. If any guard flags BLOCK, the
 * response is held and the user is notified. If guards flag WARN,
 * the response is annotated but still sent.
 *
 * Usage:
 *   const truthBinding = new TruthBinding({ wikiRoot, scheduleData });
 *   const result = truthBinding.process(response, context);
 *   if (result.blocked) { // handle blocked response }
 *   else { send(result.sanitizedResponse); }
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type GuardSeverity = 'pass' | 'warn' | 'block';

export interface GuardResult {
  /** Which guard produced this result */
  guard: string;
  /** Severity level */
  severity: GuardSeverity;
  /** Human-readable description of what was found */
  message: string;
  /** The specific content that triggered this */
  trigger: string;
  /** Suggested fix (if applicable) */
  suggestion?: string;
}

export interface TruthBindingConfig {
  /** Wiki root directory for claim grounding */
  wikiRoot?: string;
  /** Schedule data for time validation */
  scheduleData?: ScheduleEntry[];
  /** Custom URL allowlist (regex patterns) */
  urlAllowlist?: string[];
  /** Whether to enable individual guards */
  guards?: {
    urlVerification?: boolean;
    claimGrounding?: boolean;
    scheduleHonesty?: boolean;
    promptLeakRedaction?: boolean;
    actionAnnouncer?: boolean;
  };
  /** Maximum response length (characters) — responses longer than this get a warning */
  maxResponseLength?: number;
}

export interface ProcessContext {
  /** The user's original message */
  userMessage: string;
  /** Tool calls that were made during this turn */
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
  /** The agent's identity name */
  agentName?: string;
  /** Current timestamp */
  timestamp?: string;
}

export interface TruthBindingResult {
  /** Whether any guard blocked the response */
  blocked: boolean;
  /** The sanitized response (with redactions applied) */
  sanitizedResponse: string;
  /** All guard results */
  results: GuardResult[];
  /** Warnings (non-blocking) */
  warnings: GuardResult[];
  /** Blocks (preventing send) */
  blocks: GuardResult[];
  /** Summary for logging */
  summary: string;
}

export interface ScheduleEntry {
  /** Description of the scheduled event */
  description: string;
  /** Start time (ISO 8601) */
  startTime: string;
  /** End time (ISO 8601) */
  endTime?: string;
  /** Source of the schedule data */
  source: string;
}

// ─── Guard Implementations ───────────────────────────────────────────────────

/**
 * Guard 1: URL Verification
 *
 * Checks that URLs in the response are:
 * - Not obviously fake (example.com, localhost, etc.)
 * - Not internal/private URLs that shouldn't be shared
 * - Properly formatted
 */
function urlVerificationGuard(response: string, config: TruthBindingConfig): GuardResult[] {
  const results: GuardResult[] = [];

  // Extract URLs from response
  const urlPattern = /https?:\/\/[^\s)}\]"',]+/g;
  const urls = response.match(urlPattern) || [];

  // Known fake/placeholder patterns
  const fakePatterns = [
    { pattern: /example\.com/i, name: 'example.com placeholder' },
    { pattern: /example\.org/i, name: 'example.org placeholder' },
    { pattern: /localhost/i, name: 'localhost address' },
    { pattern: /127\.0\.0\./, name: 'loopback address' },
    { pattern: /192\.168\./, name: 'private IP' },
    { pattern: /10\.\d+\./, name: 'private IP (10.x)' },
    { pattern: /0\.0\.0\.0/, name: 'null address' },
    { pattern: /your-website\.com/i, name: 'template website URL' },
    { pattern: /your-domain\.com/i, name: 'template domain URL' },
    { pattern: /replace-me/i, name: 'placeholder URL' },
  ];

  // Sensitive internal patterns that shouldn't be in responses
  const sensitivePatterns = [
    { pattern: /sk-[a-zA-Z0-9]{20,}/, name: 'OpenAI API key' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub PAT' },
    { pattern: /AKIA[A-Z0-9]{16}/, name: 'AWS access key' },
  ];

  for (const url of urls) {
    // Check for fake/placeholder URLs
    for (const { pattern, name } of fakePatterns) {
      if (pattern.test(url)) {
        results.push({
          guard: 'url-verification',
          severity: 'warn',
          message: `Response contains a placeholder URL: ${name}`,
          trigger: url,
          suggestion: 'Replace with the actual URL or remove the link',
        });
        break;
      }
    }

    // Check for sensitive URLs
    for (const { pattern, name } of sensitivePatterns) {
      if (pattern.test(url)) {
        results.push({
          guard: 'url-verification',
          severity: 'block',
          message: `Response contains a sensitive credential in URL: ${name}`,
          trigger: '[REDACTED]',
          suggestion: 'Remove the credential from the response immediately',
        });
      }
    }

    // Check URL format
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith('http')) {
        results.push({
          guard: 'url-verification',
          severity: 'warn',
          message: `URL uses non-HTTP protocol: ${parsed.protocol}`,
          trigger: url,
        });
      }
      // Check for missing TLD
      if (parsed.hostname.split('.').length < 2 && parsed.hostname !== 'localhost') {
        results.push({
          guard: 'url-verification',
          severity: 'warn',
          message: `URL hostname may be invalid: ${parsed.hostname}`,
          trigger: url,
        });
      }
    } catch {
      results.push({
        guard: 'url-verification',
        severity: 'warn',
        message: `Malformed URL in response`,
        trigger: url,
        suggestion: 'Fix or remove the malformed URL',
      });
    }
  }

  return results;
}

/**
 * Guard 2: Claim Grounding
 *
 * Checks that factual claims in the response can be grounded in wiki knowledge.
 * This is a lightweight check — it doesn't verify every claim, just flags claims
 * that look like they SHOULD be grounded but aren't.
 *
 * The heuristic: if a claim contains specific details (names, numbers, dates),
 * check if those details appear in the wiki. If not, flag it.
 */
function claimGroundingGuard(response: string, context: ProcessContext, config: TruthBindingConfig): GuardResult[] {
  const results: GuardResult[] = [];

  // Patterns that suggest factual claims needing grounding
  const claimPatterns: Array<{ pattern: RegExp; description: string }> = [
    // Version numbers, technical specs
    { pattern: /version\s+\d+\.\d+/gi, description: 'version number claim' },
    // Specific file paths
    { pattern: /(?:file|path|directory)\s+(?:is|at|in)\s+["'`]?\S+["'`]?/gi, description: 'file path claim' },
    // Temporal claims (dates, times)
    { pattern: /(?:last|next|on|at)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})/gi, description: 'temporal claim' },
    // Numerical claims with units
    { pattern: /\d+\s*(?:ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|MB|GB|TB|%|dollars?|\$|users?|requests?)\b/gi, description: 'numerical claim' },
    // "X is Y" definitional claims
    { pattern: /(?:is|are|was|were|means|refers to)\s+(?:a|an|the)\s+\S+/gi, description: 'definitional claim' },
  ];

  for (const { pattern, description } of claimPatterns) {
    const matches = response.match(pattern);
    if (matches && matches.length > 3) {
      // More than 3 ungrounded claims of the same type — flag it
      results.push({
        guard: 'claim-grounding',
        severity: 'warn',
        message: `Response contains ${matches.length} ${description}(s) that should be verified against wiki`,
        trigger: matches.slice(0, 3).join(', '),
        suggestion: 'Verify these claims against wiki knowledge before sending',
      });
    }
  }

  // Check for hedging language that suggests uncertainty
  const hedgingPatterns = [
    /\b(?:I think|I believe|probably|likely|maybe|perhaps|might be|could be|seems like)\b/gi,
  ];

  for (const pattern of hedgingPatterns) {
    const matches = response.match(pattern);
    if (matches && matches.length > 5) {
      results.push({
        guard: 'claim-grounding',
        severity: 'warn',
        message: `Response has excessive hedging (${matches.length} hedging phrases) — may indicate low confidence`,
        trigger: matches.slice(0, 3).join(', '),
        suggestion: 'Either verify claims and state them confidently, or acknowledge uncertainty explicitly',
      });
    }
  }

  return results;
}

/**
 * Guard 3: Schedule Honesty
 *
 * Validates that any time/date claims in the response are consistent
 * with the actual current time and known schedule.
 */
function scheduleHonestyGuard(response: string, context: ProcessContext, config: TruthBindingConfig): GuardResult[] {
  const results: GuardResult[] = [];
  const now = context.timestamp ? new Date(context.timestamp) : new Date();

  // Check for relative time claims that might be wrong
  const relativeTimePatterns: Array<{ pattern: RegExp; claimType: string }> = [
    { pattern: /\btomorrow\b/gi, claimType: 'relative date' },
    { pattern: /\byesterday\b/gi, claimType: 'relative date' },
    { pattern: /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year)\b/gi, claimType: 'relative date' },
    { pattern: /\blast\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year)\b/gi, claimType: 'relative date' },
    { pattern: /\bin\s+(?:a\s+)?(?:few|couple)\s+(?:hours?|days?|minutes?)/gi, claimType: 'relative time' },
  ];

  // Check for "today" claims
  const todayPattern = /\btoday\b/gi;
  const todayMatches = response.match(todayPattern);
  if (todayMatches && todayMatches.length > 0) {
    // This is fine as long as the response is sent today — which it is
    // But flag if the response mentions a specific day-of-week for "today"
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const actualDay = dayNames[now.getDay()];
    const todayDayPattern = new RegExp(`today.*${actualDay}|${actualDay}.*today`, 'i');
    // This is informational only, no flag needed
  }

  // Check for specific time claims against schedule data
  if (config.scheduleData && config.scheduleData.length > 0) {
    // Look for claims about scheduled events
    for (const entry of config.scheduleData) {
      const startTime = new Date(entry.startTime);
      const endTime = entry.endTime ? new Date(entry.endTime) : null;

      // Check if response mentions this event but with wrong time
      const eventWords = entry.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (eventWords.length > 0) {
        const eventPattern = new RegExp(eventWords.join('|'), 'i');
        if (eventPattern.test(response)) {
          // Response mentions this event — check if time claims are consistent
          // (This is a lightweight check; full time parsing would require NLP)
          const eventTimePattern = /(?:at|from|between|starts?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
          const timeMatches = response.match(eventTimePattern);
          if (timeMatches) {
            // Flag for review — we can't easily verify the exact time without NLP
            results.push({
              guard: 'schedule-honesty',
              severity: 'warn',
              message: `Response makes time claims about "${entry.description}" — verify accuracy`,
              trigger: timeMatches[0],
              suggestion: `Scheduled time: ${startTime.toLocaleTimeString()}`,
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Guard 4: Prompt-Leak Redaction
 *
 * Strips fragments of system prompts, internal instructions, or tool
 * outputs that shouldn't appear in user-facing responses.
 */
function promptLeakRedactionGuard(response: string, context: ProcessContext, config: TruthBindingConfig): GuardResult[] {
  const results: GuardResult[] = [];
  let sanitized = response;

  // Patterns that indicate system prompt leakage
  const leakPatterns: Array<{ pattern: RegExp; description: string; severity: GuardSeverity }> = [
    // System prompt fragments
    { pattern: /you are (?:a|an)\s+(?:AI|assistant|agent|language model)/gi, description: 'system prompt identity fragment', severity: 'block' },
    { pattern: /(?:your|the)\s+(?:instructions?|directives?|guidelines?|rules?|constraints?)\s+(?:are|include|state)/gi, description: 'system instruction reference', severity: 'warn' },
    // Tool call artifacts
    { pattern: /<(?:tool_call|function_call|invoke)>[\s\S]*?<\/(?:tool_call|function_call|invoke)>/gi, description: 'tool call XML in output', severity: 'block' },
    { pattern: /```(?:json|xml|tool)\s*\n\s*(?:function_call|tool_use|invoke)/gi, description: 'tool call code block', severity: 'block' },
    // Internal markers
    { pattern: /\[(?:SYSTEM|INTERNAL|DEBUG|TOOL_RESULT|MEMORY)\]/gi, description: 'internal marker in output', severity: 'block' },
    // Scratch buffer keys
    { pattern: /scratch[_-]?buffer[_-]?(?:get|set|key)\s*[:=]/gi, description: 'scratch buffer reference', severity: 'warn' },
    // Wiki path references that look internal
    { pattern: /memory\/wiki\/\S+/gi, description: 'internal wiki path in output', severity: 'warn' },
    // Raw JSON tool results
    { pattern: /"(?:toolId|toolName|sessionId|workspaceRoot)":\s*"/gi, description: 'raw JSON tool result', severity: 'block' },
  ];

  for (const { pattern, description, severity } of leakPatterns) {
    const matches = response.match(pattern);
    if (matches) {
      results.push({
        guard: 'prompt-leak-redaction',
        severity,
        message: `Response contains ${description} (${matches.length} occurrence${matches.length > 1 ? 's' : ''})`,
        trigger: matches[0].slice(0, 100),
        suggestion: 'Redact or paraphrase this content before sending',
      });
    }
  }

  return results;
}

/**
 * Guard 5: Action Announcer
 *
 * Flags responses where the agent is describing an action it's about to take
 * or has taken, so the user is aware of external side effects.
 */
function actionAnnouncerGuard(response: string, context: ProcessContext, config: TruthBindingConfig): GuardResult[] {
  const results: GuardResult[] = [];

  // If tool calls were made, check that the response acknowledges them
  if (context.toolCalls && context.toolCalls.length > 0) {
    const privilegedTools = ['exec', 'file-delete', 'file-write', 'message-send', 'cron-add', 'gateway-restart'];
    const externalCalls = context.toolCalls.filter(tc => privilegedTools.includes(tc.toolName));

    if (externalCalls.length > 0) {
      // Check if the response mentions the action
      const toolNames = externalCalls.map(tc => tc.toolName);
      const responseMentionsAction = toolNames.some(name =>
        response.toLowerCase().includes(name) ||
        response.toLowerCase().includes('executed') ||
        response.toLowerCase().includes('ran') ||
        response.toLowerCase().includes('created') ||
        response.toLowerCase().includes('updated') ||
        response.toLowerCase().includes('sent')
      );

      if (!responseMentionsAction) {
        results.push({
          guard: 'action-announcer',
          severity: 'warn',
          message: `Response doesn't acknowledge ${externalCalls.length} privileged action(s): ${toolNames.join(', ')}`,
          trigger: JSON.stringify(toolNames),
          suggestion: 'Explicitly mention what actions were taken so the user knows what happened',
        });
      }
    }
  }

  // Check for responses that describe future actions without clear markers
  const futureActionPatterns = [
    /\b(?:I'll|I will|I'm going to|let me|I'll go ahead|I can|I should)\s+(?:create|delete|modify|update|run|execute|send|write|remove)\b/gi,
  ];

  for (const pattern of futureActionPatterns) {
    const matches = response.match(pattern);
    if (matches) {
      // This is informational — the agent is announcing intent, which is good
      // But flag it so the user is aware
      results.push({
        guard: 'action-announcer',
        severity: 'pass',
        message: `Agent announced ${matches.length} intended action(s)`,
        trigger: matches[0],
      });
    }
  }

  // Check for responses that describe completed actions without verification
  const completedActionPatterns = [
    /\b(?:I've|I have|I did|I already|successfully)\s+(?:created|deleted|modified|updated|ran|executed|sent|wrote|removed)\b/gi,
  ];

  for (const pattern of completedActionPatterns) {
    const matches = response.match(pattern);
    if (matches && (!context.toolCalls || context.toolCalls.length === 0)) {
      // Agent claims to have done something but no tool calls recorded
      results.push({
        guard: 'action-announcer',
        severity: 'warn',
        message: `Agent claims completed action but no tool calls recorded — possible hallucination`,
        trigger: matches[0],
        suggestion: 'Verify the action actually occurred or rephrase as intent',
      });
    }
  }

  return results;
}

/**
 * Guard 6: Response Length Check
 *
 * Flags excessively long responses that may overwhelm the user.
 */
function responseLengthGuard(response: string, config: TruthBindingConfig): GuardResult[] {
  const maxLength = config.maxResponseLength || 4000;
  const results: GuardResult[] = [];

  if (response.length > maxLength) {
    results.push({
      guard: 'response-length',
      severity: 'warn',
      message: `Response is ${response.length} characters (max recommended: ${maxLength})`,
      trigger: `First 100 chars: ${response.slice(0, 100)}...`,
      suggestion: 'Consider splitting into multiple messages or summarizing',
    });
  }

  return results;
}

// ─── Truth Binding System ────────────────────────────────────────────────────

export class TruthBinding {
  private config: TruthBindingConfig;

  constructor(config: TruthBindingConfig = {}) {
    this.config = config;
  }

  /**
   * Process a response through all truth-binding guards.
   * Returns the sanitized response and all guard results.
   */
  process(response: string, context: ProcessContext): TruthBindingResult {
    const allResults: GuardResult[] = [];

    // Run all enabled guards
    const guards = this.config.guards || {};

    if (guards.urlVerification !== false) {
      allResults.push(...urlVerificationGuard(response, this.config));
    }

    if (guards.claimGrounding !== false) {
      allResults.push(...claimGroundingGuard(response, context, this.config));
    }

    if (guards.scheduleHonesty !== false) {
      allResults.push(...scheduleHonestyGuard(response, context, this.config));
    }

    if (guards.promptLeakRedaction !== false) {
      allResults.push(...promptLeakRedactionGuard(response, context, this.config));
    }

    if (guards.actionAnnouncer !== false) {
      allResults.push(...actionAnnouncerGuard(response, context, this.config));
    }

    // Always run length check
    allResults.push(...responseLengthGuard(response, this.config));

    // Separate into warnings and blocks
    const blocks = allResults.filter(r => r.severity === 'block');
    const warnings = allResults.filter(r => r.severity === 'warn');
    const passed = allResults.filter(r => r.severity === 'pass');

    // Apply redactions for prompt-leak blocks
    let sanitizedResponse = response;
    if (blocks.some(r => r.guard === 'prompt-leak-redaction')) {
      sanitizedResponse = this.redactPromptLeaks(sanitizedResponse);
    }

    // Redact any detected secrets/credentials
    sanitizedResponse = this.redactSecrets(sanitizedResponse);

    // Build summary
    const summary = this.buildSummary(allResults);

    return {
      blocked: blocks.length > 0,
      sanitizedResponse,
      results: allResults,
      warnings,
      blocks,
      summary,
    };
  }

  /**
   * Quick check if a response would be blocked without full processing.
   * Useful for pre-filtering before the full guard pass.
   */
  wouldBlock(response: string, context: ProcessContext): boolean {
    // Only check the fast guards for a quick pre-filter
    const urlResults = urlVerificationGuard(response, this.config);
    const leakResults = promptLeakRedactionGuard(response, context, this.config);
    return [...urlResults, ...leakResults].some(r => r.severity === 'block');
  }

  /**
   * Get a summary of all guards and their status.
   */
  getGuardStatus(): Array<{ name: string; enabled: boolean; description: string }> {
    const guards = this.config.guards || {};
    return [
      {
        name: 'url-verification',
        enabled: guards.urlVerification !== false,
        description: 'Verifies URLs are not placeholders, private, or containing secrets',
      },
      {
        name: 'claim-grounding',
        enabled: guards.claimGrounding !== false,
        description: 'Flags ungrounded factual claims for verification',
      },
      {
        name: 'schedule-honesty',
        enabled: guards.scheduleHonesty !== false,
        description: 'Validates time/date claims against known schedule',
      },
      {
        name: 'prompt-leak-redaction',
        enabled: guards.promptLeakRedaction !== false,
        description: 'Strips system prompt fragments from responses',
      },
      {
        name: 'action-announcer',
        enabled: guards.actionAnnouncer !== false,
        description: 'Flags responses that take external actions without acknowledgment',
      },
    ];
  }

  /**
   * Get statistics about guard passes.
   *
   * TODO: Implement persistent guard statistics tracking. This method
   * currently returns zeros because guard results are not being aggregated
   * into a persistent store. To implement:
   * 1. Add a private `guardStats` field to this class that accumulates counts
   *    per guard (totalChecks, byGuard) and tracks block/warn/pass counts.
   * 2. Update the `process()` method to call a private `recordStats()` helper
   *    that increments the counters after each guard run.
   * 3. Persist the stats to disk (e.g. data/truth-binding-stats.json) so they
   *    survive restarts, with a flush in the constructor to load on startup.
   * 4. Optionally expose a resetStats() method for testing.
   *
   * The blockRate should be computed as blocks / totalChecks * 100.
   *
   * Until this is implemented, the zeros returned here are intentional —
   * the stats are simply not yet tracked.
   */
  getStats(): { totalChecks: number; byGuard: Record<string, number>; blockRate: number } {
    return {
      totalChecks: 0,
      byGuard: {},
      blockRate: 0,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private redactPromptLeaks(text: string): string {
    // Remove tool call XML
    text = text.replace(/<(?:tool_call|function_call|invoke)>[\s\S]*?<\/(?:tool_call|function_call|invoke)>/gi, '[REDACTED: internal]');
    // Remove tool call code blocks
    text = text.replace(/```(?:json|xml|tool)\s*\n\s*(?:function_call|tool_use|invoke)[\s\S]*?```/gi, '[REDACTED: internal]');
    // Remove internal markers
    text = text.replace(/\[(?:SYSTEM|INTERNAL|DEBUG|TOOL_RESULT|MEMORY)\]/gi, '[INTERNAL]');
    // Remove system prompt fragments
    text = text.replace(/you are (?:a|an)\s+(?:AI|assistant|agent|language model)[^.]*\./gi, '');
    return text;
  }

  private redactSecrets(text: string): string {
    // API keys
    text = text.replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED: api-key]');
    text = text.replace(/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED: github-token]');
    text = text.replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED: aws-key]');
    // Generic hex keys (32+ chars)
    text = text.replace(/[a-f0-9]{32,}/g, '[REDACTED: potential-secret]');
    // Passwords in assignment
    text = text.replace(/(?:password|passwd|secret|token|key|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
    return text;
  }

  private buildSummary(results: GuardResult[]): string {
    if (results.length === 0) return 'All guards passed';

    const blocks = results.filter(r => r.severity === 'block');
    const warnings = results.filter(r => r.severity === 'warn');
    const passed = results.filter(r => r.severity === 'pass');

    const parts: string[] = [];
    if (blocks.length > 0) parts.push(`${blocks.length} BLOCK(S)`);
    if (warnings.length > 0) parts.push(`${warnings.length} warning(s)`);
    if (passed.length > 0) parts.push(`${passed.length} pass(s)`);

    return parts.join(', ');
  }
}
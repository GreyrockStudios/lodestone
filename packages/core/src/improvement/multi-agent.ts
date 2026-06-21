/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Multi-Agent Coordination
 *
 * Enables an agent to spawn, manage, and coordinate sub-agents.
 * Based on the OpenClaw pattern: isolated sub-agents with clear handoffs,
 * review sub-agents for quality, and coordination protocols.
 *
 * No LLM — all coordination is deterministic rule-based.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentCoordinationConfig {
  /** Data directory */
  dataDir: string;
  /** Maximum concurrent sub-agents (default: 5) */
  maxConcurrent?: number;
  /** Default timeout for sub-agent tasks in ms (default: 5 min) */
  defaultTimeoutMs?: number;
  /** Whether to enable review sub-agents (default: true) */
  enableReview?: boolean;
}

export type SubAgentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'timed-out' | 'cancelled';

export interface SubAgentTask {
  /** Unique task ID */
  id: string;
  /** Task name (human-readable) */
  name: string;
  /** Type of sub-agent */
  type: 'worker' | 'reviewer' | 'researcher' | 'coder';
  /** Objective description */
  objective: string;
  /** Files the sub-agent can read */
  readScope: string[];
  /** Files the sub-agent can write */
  writeScope: string[];
  /** Tools the sub-agent can use */
  allowedTools: string[];
  /** Parent agent that spawned this */
  parentAgentId: string;
  /** Current status */
  status: SubAgentStatus;
  /** Priority (0 = highest) */
  priority: number;
  /** Result (when completed) */
  result?: SubAgentResult;
  /** Error (when failed) */
  error?: string;
  /** Timestamps */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Timeout duration */
  timeoutMs: number;
}

export interface SubAgentResult {
  /** Summary of what was accomplished */
  summary: string;
  /** Files that were read */
  filesRead: string[];
  /** Files that were written */
  filesWritten: string[];
  /** Tools that were used */
  toolsUsed: string[];
  /** Whether the objective was achieved */
  success: boolean;
  /** Artifacts produced */
  artifacts: string[];
  /** Duration in ms */
  durationMs: number;
}

export interface CoordinationHandoff {
  /** Handoff ID */
  id: string;
  /** Source agent */
  from: string;
  /** Target agent */
  to: string;
  /** Context being handed off */
  context: string;
  /** Files relevant to the handoff */
  relevantFiles: string[];
  /** Whether the handoff was accepted */
  accepted: boolean;
  /** Timestamp */
  createdAt: string;
  /** Accepted/rejected at */
  resolvedAt?: string;
}

export interface ReviewRequest {
  /** Review ID */
  id: string;
  /** Task being reviewed */
  taskId: string;
  /** What to review */
  target: string;
  /** Type of review */
  reviewType: 'code-review' | 'fact-check' | 'quality-gate' | 'safety-audit';
  /** Review criteria */
  criteria: string[];
  /** Review result */
  result?: ReviewResult;
  /** Priority */
  priority: number;
  /** Timestamps */
  createdAt: string;
  resolvedAt?: string;
}

export interface ReviewResult {
  /** Whether the review passed */
  passed: boolean;
  /** Issues found */
  issues: ReviewIssue[];
  /** Overall assessment */
  assessment: string;
  /** Confidence (0-1) */
  confidence: number;
}

export interface ReviewIssue {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category: string;
  description: string;
  location?: string;
  suggestion?: string;
}

export interface CoordinationStats {
  totalSpawned: number;
  activeNow: number;
  completed: number;
  failed: number;
  timedOut: number;
  avgDurationMs: number;
  reviewsCompleted: number;
  reviewsPassed: number;
  reviewsFailed: number;
  handoffsCompleted: number;
}

// ─── Type Aliases for backward compat ─────────────────────────────────────────

export type SubagentConfig = AgentCoordinationConfig;
export type SubagentTask = SubAgentTask;
export type SubagentResult = SubAgentResult;
export type SubagentStatus = SubAgentStatus;
export type SubagentHandoff = CoordinationHandoff;

// ─── Review Sub-Agent ────────────────────────────────────────────────────────

/**
 * Delegates review work to the multi-agent coordinator.
 * Wraps deterministic code review + the coordination protocol.
 */
export class ReviewSubagent {
  private coordinator: MultiAgentCoordinator;

  constructor(coordinator: MultiAgentCoordinator) {
    this.coordinator = coordinator;
  }

  /**
   * Request a review for the given code/file.
   * Spawns a reviewer sub-agent and performs deterministic review.
   */
  async requestCodeReview(
    filePath: string,
    code: string,
    criteria: string[] = ['correctness', 'safety', 'style'],
    priority: number = 5,
  ): Promise<{ task: SubAgentTask; review: ReviewResult }> {
    const task = this.coordinator.spawnTask({
      name: `Review: ${filePath}`,
      type: 'reviewer',
      objective: `Review ${filePath} for ${criteria.join(', ')}`,
      readScope: [filePath],
      writeScope: [],
      allowedTools: ['read'],
      priority,
    });

    const review = this.coordinator.performDeterministicReview(code, filePath);

    // Resolve any pending review for this task
    const pendingReviews = this.coordinator.getPendingReviews();
    for (const req of pendingReviews) {
      if (req.taskId === task.id) {
        this.coordinator.resolveReview(req.id, review);
        break;
      }
    }

    // Complete the task
    this.coordinator.completeTask(task.id, {
      summary: review.passed ? 'Review passed' : `Review failed: ${review.issues.length} issues`,
      filesRead: [filePath],
      filesWritten: [],
      toolsUsed: ['read', 'review'],
      success: review.passed,
      artifacts: [],
      durationMs: 0,
    });

    return { task, review };
  }

  /**
   * Get all pending reviews.
   */
  getPendingReviews(): ReviewRequest[] {
    return this.coordinator.getPendingReviews();
  }

  /**
   * Get review statistics.
   */
  getReviewStats(): { completed: number; passed: number; failed: number } {
    const stats = this.coordinator.getStats();
    return {
      completed: stats.reviewsCompleted,
      passed: stats.reviewsPassed,
      failed: stats.reviewsFailed,
    };
  }
}

// ─── Multi-Agent Coordinator ─────────────────────────────────────────────────

export class MultiAgentCoordinator {
  private config: Required<AgentCoordinationConfig>;
  private activeAgents: Map<string, SubAgentTask> = new Map();
  private completedAgents: SubAgentTask[] = [];
  private handoffs: CoordinationHandoff[] = [];
  private reviews: ReviewRequest[] = [];
  private agentId: string;
  private stats: CoordinationStats;

  constructor(config: AgentCoordinationConfig) {
    this.config = {
      dataDir: config.dataDir,
      maxConcurrent: config.maxConcurrent ?? 5,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 5 * 60 * 1000,
      enableReview: config.enableReview ?? true,
    };

    this.agentId = `agent-${randomUUID().slice(0, 8)}`;

    this.stats = {
      totalSpawned: 0,
      activeNow: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      avgDurationMs: 0,
      reviewsCompleted: 0,
      reviewsPassed: 0,
      reviewsFailed: 0,
      handoffsCompleted: 0,
    };

    try { mkdirSync(this.config.dataDir, { recursive: true }); } catch { /* exists */ }
  }

  async init(): Promise<void> {
    const statsPath = join(this.config.dataDir, 'coordination-stats.json');
    if (existsSync(statsPath)) {
      try {
        this.stats = JSON.parse(readFileSync(statsPath, 'utf-8'));
      } catch { /* fresh */ }
    }

    const completedPath = join(this.config.dataDir, 'completed-agents.json');
    if (existsSync(completedPath)) {
      try {
        this.completedAgents = JSON.parse(readFileSync(completedPath, 'utf-8'));
      } catch { /* fresh */ }
    }
  }

  /**
   * Spawn a new sub-agent task.
   */
  spawnTask(params: {
    name: string;
    type: SubAgentTask['type'];
    objective: string;
    readScope?: string[];
    writeScope?: string[];
    allowedTools?: string[];
    priority?: number;
    timeoutMs?: number;
  }): SubAgentTask {
    if (this.activeAgents.size >= this.config.maxConcurrent) {
      throw new Error(`Maximum concurrent sub-agents reached (${this.config.maxConcurrent}). Wait for a running sub-agent to finish before spawning another.`);
    }

    const task: SubAgentTask = {
      id: `task-${Date.now()}-${randomUUID().slice(0, 6)}`,
      name: params.name,
      type: params.type,
      objective: params.objective,
      readScope: params.readScope || ['/workspace'],
      writeScope: params.writeScope || [],
      allowedTools: params.allowedTools || ['read', 'write', 'search'],
      parentAgentId: this.agentId,
      status: 'spawning',
      priority: params.priority ?? 5,
      timeoutMs: params.timeoutMs ?? this.config.defaultTimeoutMs,
      createdAt: new Date().toISOString(),
    };

    this.activeAgents.set(task.id, task);
    this.stats.totalSpawned++;
    this.stats.activeNow = this.activeAgents.size;
    this.saveState();

    return task;
  }

  /**
   * Start a spawned task (transition from spawning to running).
   */
  startTask(taskId: string): SubAgentTask | null {
    const task = this.activeAgents.get(taskId);
    if (!task || task.status !== 'spawning') return null;

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.saveState();
    return task;
  }

  /**
   * Complete a running task with results.
   */
  completeTask(taskId: string, result: SubAgentResult): SubAgentTask | null {
    const task = this.activeAgents.get(taskId);
    if (!task) return null;

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date().toISOString();

    this.stats.completed++;
    this.stats.avgDurationMs = result.durationMs;

    this.completedAgents.push(task);
    this.activeAgents.delete(taskId);
    this.stats.activeNow = this.activeAgents.size;
    this.saveState();

    // If review is enabled, auto-request review for completed work
    if (this.config.enableReview && result.filesWritten.length > 0) {
      this.requestReview({
        taskId: task.id,
        target: result.filesWritten.join(', '),
        reviewType: 'code-review',
        criteria: ['correctness', 'safety', 'style'],
        priority: task.priority,
      });
    }

    return task;
  }

  /**
   * Fail a running task.
   */
  failTask(taskId: string, error: string): SubAgentTask | null {
    const task = this.activeAgents.get(taskId);
    if (!task) return null;

    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date().toISOString();

    this.stats.failed++;
    this.completedAgents.push(task);
    this.activeAgents.delete(taskId);
    this.stats.activeNow = this.activeAgents.size;
    this.saveState();

    return task;
  }

  /**
   * Cancel a task.
   */
  cancelTask(taskId: string): SubAgentTask | null {
    const task = this.activeAgents.get(taskId);
    if (!task) return null;

    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();

    this.completedAgents.push(task);
    this.activeAgents.delete(taskId);
    this.stats.activeNow = this.activeAgents.size;
    this.saveState();

    return task;
  }

  /**
   * Check for timed-out tasks.
   */
  checkTimeouts(): SubAgentTask[] {
    const now = Date.now();
    const timedOut: SubAgentTask[] = [];

    for (const [id, task] of this.activeAgents) {
      if (task.status !== 'running' && task.status !== 'spawning') continue;

      const startMs = task.startedAt ? new Date(task.startedAt).getTime() : new Date(task.createdAt).getTime();
      if (now - startMs > task.timeoutMs) {
        task.status = 'timed-out';
        task.error = `Task timed out after ${task.timeoutMs}ms`;
        task.completedAt = new Date().toISOString();

        this.stats.timedOut++;
        timedOut.push(task);

        this.completedAgents.push(task);
        this.activeAgents.delete(id);
      }
    }

    if (timedOut.length > 0) {
      this.stats.activeNow = this.activeAgents.size;
      this.saveState();
    }

    return timedOut;
  }

  /**
   * Request a review from a review sub-agent.
   */
  requestReview(params: {
    taskId: string;
    target: string;
    reviewType: ReviewRequest['reviewType'];
    criteria: string[];
    priority?: number;
  }): ReviewRequest {
    const review: ReviewRequest = {
      id: `review-${Date.now()}-${randomUUID().slice(0, 6)}`,
      taskId: params.taskId,
      target: params.target,
      reviewType: params.reviewType,
      criteria: params.criteria,
      priority: params.priority ?? 5,
      createdAt: new Date().toISOString(),
    };

    this.reviews.push(review);
    this.saveState();

    return review;
  }

  /**
   * Resolve a review with a result.
   * Uses deterministic quality rules — no LLM.
   */
  resolveReview(reviewId: string, result: ReviewResult): ReviewRequest | null {
    const review = this.reviews.find(r => r.id === reviewId);
    if (!review) return null;

    review.result = result;
    review.resolvedAt = new Date().toISOString();

    this.stats.reviewsCompleted++;
    if (result.passed) {
      this.stats.reviewsPassed++;
    } else {
      this.stats.reviewsFailed++;
    }

    this.saveState();
    return review;
  }

  /**
   * Perform deterministic code review.
   * Checks for common issues without using an LLM.
   */
  performDeterministicReview(code: string, filePath: string): ReviewResult {
    const issues: ReviewIssue[] = [];
    let confidence = 0.7; // Start with moderate confidence for deterministic review

    // Check for secrets
    const secretPatterns = [
      { pattern: /sk-[a-zA-Z0-9]{20,}/g, name: 'OpenAI API key' },
      { pattern: /ghp_[a-zA-Z0-9]{36}/g, name: 'GitHub token' },
      { pattern: /AKIA[A-Z0-9]{16}/g, name: 'AWS access key' },
      { pattern: /password\s*[:=]\s*["'][^"']+["']/gi, name: 'Hardcoded password' },
      { pattern: /token\s*[:=]\s*["'][^"']+["']/gi, name: 'Hardcoded token' },
    ];

    for (const { pattern, name } of secretPatterns) {
      if (pattern.test(code)) {
        issues.push({
          severity: 'critical',
          category: 'security',
          description: `Found ${name} in ${filePath}`,
          location: filePath,
          suggestion: 'Move to environment variables',
        });
        confidence = Math.min(confidence + 0.2, 1.0); // Higher confidence on security findings
      }
      pattern.lastIndex = 0; // Reset regex
    }

    // Check for console.log in production code
    const consoleLogMatches = code.match(/console\.(log|warn|error)\(/g);
    if (consoleLogMatches && consoleLogMatches.length > 3) {
      issues.push({
        severity: 'minor',
        category: 'code-quality',
        description: `Found ${consoleLogMatches.length} console.* calls in ${filePath}`,
        location: filePath,
        suggestion: 'Use structured logger instead',
      });
    }

    // Check for TODO/FIXME/HACK comments
    const todoMatches = code.match(/\/\/\s*(TODO|FIXME|HACK|XXX)/gi);
    if (todoMatches && todoMatches.length > 5) {
      issues.push({
        severity: 'info',
        category: 'maintenance',
        description: `Found ${todoMatches.length} TODO/FIXME/HACK comments in ${filePath}`,
        location: filePath,
      });
    }

    // Check for overly long functions (>100 lines)
    const functionPattern = /(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z]+)\s*=>)/g;
    let match: RegExpExecArray | null;
    while ((match = functionPattern.exec(code)) !== null) {
      const startLine = code.substring(0, match.index).split('\n').length;
      const rest = code.substring(match.index);
      const braceCount = { open: 0, close: 0 };
      let funcEnd = 0;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '{') braceCount.open++;
        if (rest[i] === '}') braceCount.close++;
        if (braceCount.open > 0 && braceCount.close === braceCount.open) {
          funcEnd = i;
          break;
        }
      }
      const funcLines = rest.substring(0, funcEnd).split('\n').length;
      if (funcLines > 100) {
        issues.push({
          severity: 'minor',
          category: 'code-quality',
          description: `Function at line ${startLine} is ${funcLines} lines long`,
          location: `${filePath}:${startLine}`,
          suggestion: 'Consider breaking into smaller functions',
        });
      }
    }

    // Check for unhandled promise rejections (missing .catch or try-catch)
    const asyncAwaitCount = (code.match(/\bawait\b/g) || []).length;
    const tryCatchCount = (code.match(/\btry\b/g) || []).length;
    const catchCount = (code.match(/\.catch\(/g) || []).length;
    if (asyncAwaitCount > 5 && tryCatchCount + catchCount < asyncAwaitCount * 0.3) {
      issues.push({
        severity: 'major',
        category: 'error-handling',
        description: `Only ${tryCatchCount + catchCount} error handlers for ${asyncAwaitCount} async operations`,
        location: filePath,
        suggestion: 'Add error handling for async operations',
      });
    }

    // Check for path traversal risks
    if (code.includes('..') && (code.includes('path.join') || code.includes('path.resolve'))) {
      const traversalCheck = code.match(/\.\.(?:\/|\\)/g);
      if (traversalCheck) {
        issues.push({
          severity: 'critical',
          category: 'security',
          description: 'Potential path traversal vulnerability',
          location: filePath,
          suggestion: 'Validate and sanitize file paths',
        });
      }
    }

    const criticals = issues.filter(i => i.severity === 'critical');
    const majors = issues.filter(i => i.severity === 'major');
    const passed = criticals.length === 0 && majors.length === 0;

    return {
      passed,
      issues,
      assessment: passed
        ? `Review passed with ${issues.length} minor/info issues`
        : `Review failed: ${criticals.length} critical, ${majors.length} major issues`,
      confidence,
    };
  }

  /**
   * Create a handoff between agents.
   */
  createHandoff(params: {
    from: string;
    to: string;
    context: string;
    relevantFiles: string[];
  }): CoordinationHandoff {
    const handoff: CoordinationHandoff = {
      id: `handoff-${Date.now()}-${randomUUID().slice(0, 6)}`,
      from: params.from,
      to: params.to,
      context: params.context,
      relevantFiles: params.relevantFiles,
      accepted: false,
      createdAt: new Date().toISOString(),
    };

    this.handoffs.push(handoff);
    this.saveState();
    return handoff;
  }

  /**
   * Accept a handoff.
   */
  acceptHandoff(handoffId: string): CoordinationHandoff | null {
    const handoff = this.handoffs.find(h => h.id === handoffId);
    if (!handoff) return null;

    handoff.accepted = true;
    handoff.resolvedAt = new Date().toISOString();

    this.stats.handoffsCompleted++;
    this.saveState();
    return handoff;
  }

  /**
   * Get active agents.
   */
  getActiveAgents(): SubAgentTask[] {
    return Array.from(this.activeAgents.values());
  }

  /**
   * Get pending reviews.
   */
  getPendingReviews(): ReviewRequest[] {
    return this.reviews.filter(r => !r.result);
  }

  /**
   * Get coordination statistics.
   */
  getStats(): CoordinationStats {
    this.stats.activeNow = this.activeAgents.size;
    return { ...this.stats };
  }

  /**
   * Format agent status for dashboard display.
   */
  formatStatus(): string {
    const active = this.activeAgents.size;
    const pending = this.reviews.filter(r => !r.result).length;
    return [
      `Active agents: ${active}/${this.config.maxConcurrent}`,
      `Completed: ${this.stats.completed} | Failed: ${this.stats.failed} | Timed out: ${this.stats.timedOut}`,
      `Reviews pending: ${pending} | Completed: ${this.stats.reviewsCompleted}`,
      `Handoffs: ${this.stats.handoffsCompleted}`,
    ].join('\n');
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private saveState(): void {
    writeFileSync(
      join(this.config.dataDir, 'coordination-stats.json'),
      JSON.stringify(this.stats, null, 2),
    );
    writeFileSync(
      join(this.config.dataDir, 'completed-agents.json'),
      JSON.stringify(this.completedAgents.slice(-100), null, 2),
    );
  }
}
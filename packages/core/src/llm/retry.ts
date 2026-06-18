/**
 * Lodestone Core — LLM Retry Handler
 *
 * Exponential backoff retry with circuit breaker support.
 * Retries on transient errors (connection, 503, 502, 429).
 * Does NOT retry on auth/validity errors (400, 401, 403).
 */

import { getLogger, type Logger } from '../utils/logger.js';
import type { ChildLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 500) */
  initialDelayMs?: number;
  /** Maximum delay cap in ms (default: 8000) */
  maxDelayMs?: number;
  /** Backoff multiplier between retries (default: 2) */
  backoffMultiplier?: number;
}

export interface RetryStats {
  totalAttempts: number;
  totalRetries: number;
  totalSuccesses: number;
  totalFailures: number;
  consecutiveFailures: number;
  successRate: number;
}

// ─── Error Classification ────────────────────────────────────────────────────

/** Errors that should trigger a retry */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Errors that should NOT retry — auth/validity problems */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403]);

export class RetryableError extends Error {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly isRetryable: boolean;

  constructor(message: string, opts: { statusCode?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'RetryableError';
    this.statusCode = opts.statusCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.cause = opts.cause;

    if (opts.statusCode !== undefined) {
      this.isRetryable = RETRYABLE_STATUS_CODES.has(opts.statusCode);
    } else {
      // Connection errors (no status code) are retryable
      this.isRetryable = true;
    }
  }
}

export class NonRetryableError extends Error {
  readonly statusCode?: number;

  constructor(message: string, opts: { statusCode?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'NonRetryableError';
    this.statusCode = opts.statusCode;
    this.cause = opts.cause;
  }
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures to trip the circuit (default: 5) */
  failureThreshold?: number;
  /** Time window for counting failures in ms (default: 60000) */
  failureWindowMs?: number;
  /** How long the circuit stays open in ms (default: 60000) */
  openDurationMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = []; // timestamps of recent failures
  private openedAt: number = 0;
  private config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      failureWindowMs: config.failureWindowMs ?? 60000,
      openDurationMs: config.openDurationMs ?? 60000,
    };
  }

  /** Record a failure and potentially trip the circuit */
  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    // Prune old failures outside the window
    this.failures = this.failures.filter(t => now - t < this.config.failureWindowMs);

    if (this.state === 'half-open') {
      this.trip();
      return;
    }

    if (this.failures.length >= this.config.failureThreshold) {
      this.trip();
    }
  }

  /** Record a success — resets the breaker if half-open */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.reset();
    }
  }

  /** Check if the circuit is open (calls should be blocked) */
  isOpen(): boolean {
    if (this.state === 'open') {
      // Check if we should transition to half-open
      if (Date.now() - this.openedAt >= this.config.openDurationMs) {
        this.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  /** Get current circuit state */
  getState(): CircuitState {
    return this.state;
  }

  /** Manually reset the breaker */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.openedAt = 0;
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = Date.now();
  }
}

// ─── Retry Handler ───────────────────────────────────────────────────────────

export class RetryHandler {
  private config: Required<RetryConfig>;
  private logger: Logger | ChildLogger = getLogger('retry-handler');
  private stats: RetryStats = {
    totalAttempts: 0,
    totalRetries: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    successRate: 0,
  };

  constructor(config: RetryConfig = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      initialDelayMs: config.initialDelayMs ?? 500,
      maxDelayMs: config.maxDelayMs ?? 8000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
    };
  }

  /**
   * Execute fn with retry + exponential backoff.
   * Retries on transient errors. Throws immediately on non-retryable errors.
   */
  async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    let attempt = 0;

    for (attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      this.stats.totalAttempts++;

      try {
        const result = await fn();
        this.stats.totalSuccesses++;
        this.stats.consecutiveFailures = 0;
        this.updateSuccessRate();

        if (attempt > 0) {
          this.logger.info('Retry succeeded', { attempt, previousErrors: attempt });
        }

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Non-retryable error — throw immediately
        if (err instanceof NonRetryableError) {
          this.stats.totalFailures++;
          this.stats.consecutiveFailures++;
          this.updateSuccessRate();
          this.logger.warn('Non-retryable error, not retrying', {
            error: lastError.message,
            statusCode: err.statusCode,
          });
          throw err;
        }

        // Check if retryable
        const isRetryable = err instanceof RetryableError
          ? err.isRetryable
          : !(err instanceof NonRetryableError);

        if (!isRetryable || attempt >= this.config.maxRetries) {
          this.stats.totalFailures++;
          this.stats.consecutiveFailures++;
          this.updateSuccessRate();
          this.logger.error('Retries exhausted', {
            attempts: attempt + 1,
            error: lastError.message,
          });
          throw lastError;
        }

        // Calculate delay with exponential backoff
        let delay = this.config.initialDelayMs * Math.pow(this.config.backoffMultiplier, attempt);
        delay = Math.min(delay, this.config.maxDelayMs);

        // Respect Retry-After header if present (for 429)
        if (err instanceof RetryableError && err.retryAfterMs) {
          delay = Math.max(delay, err.retryAfterMs);
        }

        this.stats.totalRetries++;
        this.updateSuccessRate();

        this.logger.warn('Retrying after error', {
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries,
          delayMs: delay,
          error: lastError.message,
          statusCode: err instanceof RetryableError ? err.statusCode : undefined,
        });

        await this.sleep(delay);
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new Error('Retry handler exhausted without error');
  }

  /** Get current retry stats */
  getStats(): Readonly<RetryStats> {
    return { ...this.stats };
  }

  /** Reset stats */
  resetStats(): void {
    this.stats = {
      totalAttempts: 0,
      totalRetries: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      successRate: 0,
    };
  }

  private updateSuccessRate(): void {
    const total = this.stats.totalSuccesses + this.stats.totalFailures;
    this.stats.successRate = total > 0 ? this.stats.totalSuccesses / total : 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
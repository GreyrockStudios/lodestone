/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — LLM Rate Limiter
 *
 * Token bucket algorithm for requests, rolling window for tokens.
 * Non-async check() for fast pre-call validation.
 * Async acquire() waits if within limits, rejects if over.
 * Built-in stats tracking.
 */

import { getLogger, type Logger } from '../utils/logger.js';
import type { ChildLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum tokens per minute (default: 50000) */
  tokensPerMinute?: number;
  /** Maximum requests per minute (default: 30) */
  requestsPerMinute?: number;
  /** Burst size — max requests in a burst (default: 5) */
  burstSize?: number;
}

export interface RateLimitCheckResult {
  /** Whether the request is allowed to proceed */
  allowed: boolean;
  /** Milliseconds to wait before retrying if not allowed */
  retryAfterMs?: number;
  /** Remaining tokens in the current window */
  remaining: number;
  /** Remaining requests in the burst bucket */
  remainingRequests: number;
}

export interface RateLimitStats {
  totalRequests: number;
  totalTokens: number;
  throttledCount: number;
  currentTokensUsed: number;
  currentRequestsUsed: number;
}

// ─── Token Bucket ───────────────────────────────────────────────────────────

/**
 * Token bucket for request rate limiting.
 * Refills at a steady rate to allow bursts up to burstSize,
 * then enforces requestsPerMinute.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRatePerMs: number;

  constructor(capacity: number, refillRatePerMs: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastRefill = Date.now();
    this.refillRatePerMs = refillRatePerMs;
  }

  /** Try to consume 1 token. Returns true if allowed. */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Get remaining tokens in the bucket */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Milliseconds until 1 token is available */
  msUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.ceil(needed / this.refillRatePerMs);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refilled = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefill = now;
  }
}

// ─── Rolling Window ─────────────────────────────────────────────────────────

/**
 * Rolling window counter for token usage.
 * Tracks total tokens consumed in the last 60 seconds.
 */
class RollingWindow {
  private entries: { timestamp: number; tokens: number }[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = 60000) {
    this.windowMs = windowMs;
  }

  /** Add a token consumption event */
  add(tokens: number): void {
    this.entries.push({ timestamp: Date.now(), tokens });
    this.prune();
  }

  /** Get total tokens consumed in the current window */
  total(): number {
    this.prune();
    return this.entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  /** Get remaining capacity given a max */
  remaining(max: number): number {
    return Math.max(0, max - this.total());
  }

  /** Milliseconds until capacity is available for the given token count */
  msUntilCapacity(max: number, tokens: number): number {
    this.prune();
    const current = this.total();
    if (current + tokens <= max) return 0;

    // Find the oldest entry that needs to expire to make room
    const excess = current + tokens - max;
    let cumulative = 0;
    for (const entry of this.entries) {
      cumulative += entry.tokens;
      if (cumulative >= excess) {
        return Math.max(0, entry.timestamp + this.windowMs - Date.now());
      }
    }
    return this.windowMs;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.entries = this.entries.filter(e => e.timestamp > cutoff);
  }
}

// ─── Rate Limiter ───────────────────────────────────────────────────────────

export class RateLimiter {
  private config: Required<RateLimitConfig>;
  private logger: Logger | ChildLogger = getLogger('rate-limiter');

  private requestBucket: TokenBucket;
  private tokenWindow: RollingWindow;

  private stats: RateLimitStats = {
    totalRequests: 0,
    totalTokens: 0,
    throttledCount: 0,
    currentTokensUsed: 0,
    currentRequestsUsed: 0,
  };

  constructor(config: RateLimitConfig = {}) {
    this.config = {
      tokensPerMinute: config.tokensPerMinute ?? 50000,
      requestsPerMinute: config.requestsPerMinute ?? 30,
      burstSize: config.burstSize ?? 5,
    };

    // Token bucket: capacity = burstSize, refill rate = requestsPerMinute / 60000
    const refillRatePerMs = this.config.requestsPerMinute / 60000;
    this.requestBucket = new TokenBucket(this.config.burstSize, refillRatePerMs);

    // Rolling window for tokens: 60s window
    this.tokenWindow = new RollingWindow(60000);
  }

  /**
   * Non-async check — fast, for pre-call validation.
   * Does NOT consume tokens; use acquire() for that.
   */
  check(tokens: number): RateLimitCheckResult {
    const remainingRequests = this.requestBucket.available();
    const remainingTokens = this.tokenWindow.remaining(this.config.tokensPerMinute);
    const currentTokens = this.tokenWindow.total();

    // Check request bucket first
    if (remainingRequests < 1) {
      const retryAfterMs = this.requestBucket.msUntilAvailable();
      this.logger.debug('Rate limited: request bucket empty', {
        remainingRequests,
        retryAfterMs,
      });
      return {
        allowed: false,
        retryAfterMs,
        remaining: remainingTokens,
        remainingRequests,
      };
    }

    // Check token window
    if (currentTokens + tokens > this.config.tokensPerMinute) {
      const retryAfterMs = this.tokenWindow.msUntilCapacity(
        this.config.tokensPerMinute,
        tokens,
      );
      this.logger.debug('Rate limited: token window exceeded', {
        currentTokens,
        requested: tokens,
        max: this.config.tokensPerMinute,
        retryAfterMs,
      });
      return {
        allowed: false,
        retryAfterMs,
        remaining: remainingTokens,
        remainingRequests,
      };
    }

    return {
      allowed: true,
      remaining: remainingTokens - tokens,
      remainingRequests: remainingRequests - 1,
    };
  }

  /**
   * Acquire tokens — waits if rate limited, rejects if impossible.
   * Consumes tokens from both the request bucket and token window.
   */
  async acquire(tokens: number): Promise<void> {
    let attempts = 0;
    const maxAttempts = 100; // Safety valve — prevent infinite loops

    while (attempts < maxAttempts) {
      attempts++;
      const check = this.check(tokens);

      if (check.allowed) {
        // Consume
        this.requestBucket.tryConsume();
        this.tokenWindow.add(tokens);

        this.stats.totalRequests++;
        this.stats.totalTokens += tokens;
        this.stats.currentTokensUsed = this.tokenWindow.total();
        this.stats.currentRequestsUsed = this.config.burstSize - this.requestBucket.available();

        return;
      }

      // Need to wait
      const waitMs = check.retryAfterMs ?? 1000;
      this.stats.throttledCount++;
      this.logger.info('Rate limited, waiting', {
        tokens,
        waitMs,
        remaining: check.remaining,
        remainingRequests: check.remainingRequests,
      });
      await this.sleep(waitMs);
    }

    throw new Error(
      `Rate limiter: could not acquire ${tokens} tokens after ${maxAttempts} attempts. The LLM provider may be rate-limiting your requests. Consider reducing request frequency or increasing the rate limit.`,
    );
  }

  /**
   * Try to acquire tokens without waiting.
   * Returns true if successful, false if rate limited.
   */
  tryAcquire(tokens: number): boolean {
    const check = this.check(tokens);
    if (!check.allowed) {
      this.stats.throttledCount++;
      return false;
    }

    this.requestBucket.tryConsume();
    this.tokenWindow.add(tokens);

    this.stats.totalRequests++;
    this.stats.totalTokens += tokens;
    this.stats.currentTokensUsed = this.tokenWindow.total();
    this.stats.currentRequestsUsed = this.config.burstSize - this.requestBucket.available();

    return true;
  }

  /** Get current stats */
  getStats(): Readonly<RateLimitStats> {
    this.stats.currentTokensUsed = this.tokenWindow.total();
    this.stats.currentRequestsUsed = this.config.burstSize - this.requestBucket.available();
    return { ...this.stats };
  }

  /** Reset stats */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      totalTokens: 0,
      throttledCount: 0,
      currentTokensUsed: 0,
      currentRequestsUsed: 0,
    };
  }

  /** Get config */
  getConfig(): Readonly<Required<RateLimitConfig>> {
    return { ...this.config };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
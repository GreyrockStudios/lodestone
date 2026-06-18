/**
 * Lodestone Core — Channel Interface
 *
 * Abstract base class and types for all channel adapters.
 * Channels connect Lodestone to external messaging platforms
 * (Telegram, Discord, web chat, etc.).
 */

// ─── Channel Message ──────────────────────────────────────────────────────

export interface ChannelMessage {
  /** Unique session identifier (maps to an agent session) */
  sessionId: string;
  /** The text content of the message */
  content: string;
  /** User ID on the originating platform */
  senderId: string;
  /** Display name of the sender */
  senderName: string;
  /** Which channel this message came from */
  channelId: string;
  /** ISO timestamp */
  timestamp: string;
  /** Platform-specific metadata (reply-to IDs, attachments, etc.) */
  metadata: Record<string, unknown>;
}

// ─── Channel Config ───────────────────────────────────────────────────────

export interface ChannelConfig {
  /** Channel type identifier (e.g., 'telegram', 'discord', 'webchat') */
  type: string;
  /** Whether this channel should be started */
  enabled: boolean;
  /** Additional platform-specific config (spread into subclass) */
  [key: string]: unknown;
}

// ─── Message Handler ──────────────────────────────────────────────────────

export type MessageHandler = (message: ChannelMessage) => Promise<void>;

// ─── Channel Base Class ──────────────────────────────────────────────────

export interface ChannelHealth {
  status: 'healthy' | 'degraded' | 'down';
  active: boolean;
  messagesSent: number;
  messagesFailed: number;
  lastError: string | null;
  lastErrorAt: string | null;
  startedAt: string | null;
  uptimeMs: number;
  details?: Record<string, unknown>;
}

// ─── Rate Limiter (Token Bucket) ──────────────────────────────────────────

export interface RateLimiterConfig {
  /** Maximum messages per second */
  maxPerSecond: number;
  /** Burst capacity (default: same as maxPerSecond) */
  burst?: number;
}

class TokenBucketRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number; // tokens per ms
  private lastRefill: number;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.burst ?? config.maxPerSecond;
    this.tokens = this.maxTokens;
    this.refillRateMs = config.maxPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  /** Try to consume one token. Returns true if allowed, false if rate-limited. */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait until a token is available. Returns time to wait in ms. */
  timeUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    // Time to accumulate 1 token
    return Math.ceil((1 - this.tokens) / this.refillRateMs);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRateMs);
    this.lastRefill = now;
  }
}

// ─── Message Splitter ─────────────────────────────────────────────────────

/**
 * Split a long message into chunks at sentence boundaries, falling back to
 * word boundaries, then to hard character limits.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLength;

    // Try sentence boundary first (. ! ? followed by space/newline)
    const sentenceEnd = remaining.slice(0, maxLength).match(/[.!?]\s/g);
    if (sentenceEnd && sentenceEnd.length > 0) {
      // Find the last sentence boundary
      const lastSentenceEnd = remaining.slice(0, maxLength).lastIndexOf(sentenceEnd[sentenceEnd.length - 1]);
      if (lastSentenceEnd > maxLength * 0.3) {
        splitAt = lastSentenceEnd + 2; // Include the punctuation and space
      }
    }

    // Fall back to newline
    if (splitAt === maxLength) {
      const lastNewline = remaining.lastIndexOf('\n', maxLength);
      if (lastNewline > maxLength * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    // Fall back to word boundary
    if (splitAt === maxLength) {
      const lastSpace = remaining.lastIndexOf(' ', maxLength);
      if (lastSpace > maxLength * 0.3) {
        splitAt = lastSpace + 1;
      }
    }

    // Hard split if nothing else works
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

import { getLogger } from '../utils/logger.js';

const logger = getLogger('Channel');

export abstract class Channel {
  readonly config: ChannelConfig;
  protected messageHandler: MessageHandler | null = null;
  protected running = false;
  protected startedAt: string | null = null;

  // Health tracking
  protected messagesSent = 0;
  protected messagesFailed = 0;
  protected lastError: string | null = null;
  protected lastErrorAt: string | null = null;

  // Rate limiter (set by subclass via setRateLimit)
  private rateLimiter: TokenBucketRateLimiter | null = null;

  // Retry configuration
  private readonly maxRetries = 3;
  private readonly retryDelays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff

  // Message queue for failed sends (retry later)
  private messageQueue: Array<{ sessionId: string; message: string; attempts: number }> = [];
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  /** Unique identifier for this channel instance */
  abstract get id(): string;

  /** Human-readable name */
  abstract get name(): string;

  /** Start the channel — begin listening for messages */
  abstract start(): Promise<void>;

  /** Stop the channel — clean up resources */
  abstract stop(): Promise<void>;

  /** Send a message to a specific session on this channel (internal — subclasses implement) */
  protected abstract sendRaw(sessionId: string, message: string): Promise<void>;

  /** Get the max message length for this channel type (0 = no limit) */
  abstract getMaxMessageLength(): number;

  /** Set rate limit for this channel */
  protected setRateLimit(maxPerSecond: number, burst?: number): void {
    this.rateLimiter = new TokenBucketRateLimiter({ maxPerSecond, burst });
  }

  /** Register a handler for incoming messages */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Is the channel currently running? */
  isActive(): boolean {
    return this.running;
  }

  /** Get channel health status */
  getHealth(): ChannelHealth {
    const uptimeMs = this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0;
    let status: ChannelHealth['status'] = 'down';
    if (this.running) {
      // Degrade if error rate > 20% with > 5 messages sent
      if (this.messagesSent > 5 && this.messagesFailed / this.messagesSent > 0.2) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }
    }
    return {
      status,
      active: this.running,
      messagesSent: this.messagesSent,
      messagesFailed: this.messagesFailed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      startedAt: this.startedAt,
      uptimeMs,
    };
  }

  /**
   * Send a message with retry, rate limiting, and splitting.
   * This is the public send method — subclasses implement sendRaw().
   */
  async send(sessionId: string, message: string): Promise<void> {
    const maxLen = this.getMaxMessageLength();
    const chunks = maxLen > 0 ? splitMessage(message, maxLen) : [message];

    for (const chunk of chunks) {
      await this.sendWithRetry(sessionId, chunk);
    }
  }

  /** Send a single chunk with retry logic and rate limiting */
  private async sendWithRetry(sessionId: string, message: string): Promise<void> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Rate limiting
      if (this.rateLimiter) {
        const waitMs = this.rateLimiter.timeUntilAvailable();
        if (waitMs > 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }
        if (!this.rateLimiter.tryConsume()) {
          // Still rate-limited after waiting — try once more
          await new Promise(r => setTimeout(r, 50));
          if (!this.rateLimiter.tryConsume()) {
            // Queue for later
            this.queueMessage(sessionId, message);
            return;
          }
        }
      }

      try {
        await this.sendRaw(sessionId, message);
        this.messagesSent++;
        return; // Success
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.lastError = errorMsg;
        this.lastErrorAt = new Date().toISOString();

        if (attempt < this.maxRetries) {
          // Retry with exponential backoff
          const delay = this.retryDelays[attempt];
          logger.warn(`Send failed (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying in ${delay}ms`, { channel: this.id, error: errorMsg });
          await new Promise(r => setTimeout(r, delay));
        } else {
          // All retries exhausted — queue for later delivery
          this.messagesFailed++;
          logger.error(`Send failed after ${this.maxRetries + 1} attempts, queueing for later`, { channel: this.id, error: errorMsg });
          this.queueMessage(sessionId, message, true);
        }
      }
    }
  }

  /** Queue a message for later delivery */
  private queueMessage(sessionId: string, message: string, isRetry = false): void {
 this.messageQueue.push({ sessionId, message, attempts: 0 });
    if (isRetry) this.messagesFailed++;

    // Start queue flush timer if not running
    if (!this.queueTimer && this.running) {
      this.queueTimer = setInterval(() => this.flushQueue(), 30000); // Try every 30s
    }
  }

  /** Attempt to deliver queued messages */
  private async flushQueue(): Promise<void> {
    if (this.messageQueue.length === 0) {
      if (this.queueTimer) {
        clearInterval(this.queueTimer);
        this.queueTimer = null;
      }
      return;
    }

    const queued = [...this.messageQueue];
    this.messageQueue = [];

    for (const item of queued) {
      try {
        await this.sendRaw(item.sessionId, item.message);
        this.messagesSent++;
        logger.info('Queued message delivered', { channel: this.id, sessionId: item.sessionId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.lastError = errorMsg;
        this.lastErrorAt = new Date().toISOString();
        this.messagesFailed++;
        // Re-queue with incremented attempts (max 5 re-queues)
        if (item.attempts < 5) {
          this.messageQueue.push({ ...item, attempts: item.attempts + 1 });
        }
      }
    }
  }

  /** Emit an incoming message to the registered handler */
  protected async emitMessage(message: ChannelMessage): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(message);
    } else {
      logger.warn('No message handler registered — dropping message', { channelId: this.id, senderName: message.senderName });
    }
  }

  /** Called by subclass on start to set running state and track uptime */
  protected onStart(): void {
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.messagesSent = 0;
    this.messagesFailed = 0;
    this.lastError = null;
    this.lastErrorAt = null;
  }

  /** Called by subclass on stop to clean up */
  protected onStop(): void {
    this.running = false;
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    this.messageQueue = [];
  }
}
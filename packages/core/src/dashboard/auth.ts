/**
 * Lodestone Dashboard Authentication
 *
 * Token-based auth with per-IP rate limiting.
 * Tokens can be passed via query param, Authorization header, or cookie.
 * When no tokens are configured, auth is disabled (dev mode).
 *
 * No external dependencies — uses built-in crypto only.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { Logger, getLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuthConfig {
  /** Valid tokens. If empty or undefined, auth is disabled. */
  tokens?: string[];
  /** Max API requests per IP per minute (default: 10) */
  rateLimitPerMinute?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export interface AuthResult {
  authenticated: boolean;
  token?: string;
  reason?: string;
}

// ─── Dashboard Auth ──────────────────────────────────────────────────────────

export class DashboardAuth {
  private tokens: Set<string>;
  private rateLimitPerMinute: number;
  private logger: Logger | ReturnType<Logger['child']>;
  private ipHits: Map<string, number[]> = new Map(); // ip → timestamps of requests in current window

  constructor(config: AuthConfig = {}) {
    this.tokens = new Set(config.tokens || []);
    this.rateLimitPerMinute = config.rateLimitPerMinute ?? 10;
    this.logger = getLogger('dashboard-auth');
  }

  /**
   * Whether auth is enabled (i.e., at least one token is configured).
   */
  get enabled(): boolean {
    return this.tokens.size > 0;
  }

  /**
   * Validate a token against the configured list.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  validateToken(token: string): boolean {
    if (!this.enabled) return true; // Dev mode — no tokens configured
    if (!token) return false;

    for (const valid of this.tokens) {
      if (this.safeCompare(token, valid)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check rate limit for a given IP.
   * Returns whether the request is allowed and how many requests remain.
   */
  checkRateLimit(ip: string): RateLimitResult {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute

    // Get or create hit list for this IP
    let hits = this.ipHits.get(ip);
    if (!hits) {
      hits = [];
      this.ipHits.set(ip, hits);
    }

    // Prune hits outside the current window
    hits = hits.filter(t => now - t < windowMs);
    this.ipHits.set(ip, hits);

    const count = hits.length;
    const allowed = count < this.rateLimitPerMinute;
    const remaining = Math.max(0, this.rateLimitPerMinute - count - (allowed ? 1 : 0));

    if (allowed) {
      hits.push(now);
    }

    // Cleanup stale entries occasionally
    if (Math.random() < 0.01) {
      this.cleanupStaleEntries(now, windowMs);
    }

    return {
      allowed,
      remaining,
      resetMs: windowMs - (hits.length > 0 ? now - hits[0] : 0),
    };
  }

  /**
   * Generate a random token string.
   */
  generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Extract token from request headers, query params, or cookies.
   */
  extractToken(headers: Record<string, string | string[] | undefined>, query: Record<string, string>, cookies: Record<string, string>): string | null {
    // 1. Authorization header: Bearer xxx
    const authHeader = headers['authorization'];
    if (authHeader) {
      const val = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (val?.startsWith('Bearer ')) {
        return val.slice(7).trim();
      }
    }

    // 2. Query param: ?token=xxx
    if (query.token) {
      return query.token;
    }

    // 3. Cookie: lodestone_token=xxx
    if (cookies.lodestone_token) {
      return cookies.lodestone_token;
    }

    return null;
  }

  /**
   * Parse cookies from a Cookie header string.
   */
  static parseCookies(cookieHeader: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) return cookies;

    for (const part of cookieHeader.split(';')) {
      const [key, ...valueParts] = part.trim().split('=');
      if (key && valueParts.length > 0) {
        cookies[key.trim()] = valueParts.join('=').trim();
      }
    }
    return cookies;
  }

  /**
   * Authenticate a request given headers, query, and cookies.
   */
  authenticate(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string>,
    cookies: Record<string, string>,
  ): AuthResult {
    if (!this.enabled) {
      return { authenticated: true };
    }

    const token = this.extractToken(headers, query, cookies);
    if (!token) {
      return { authenticated: false, reason: 'No token provided' };
    }

    if (this.validateToken(token)) {
      return { authenticated: true, token };
    }

    return { authenticated: false, reason: 'Invalid token' };
  }

  /**
   * Add a token at runtime.
   */
  addToken(token: string): void {
    this.tokens.add(token);
    this.logger.info('Auth token added');
  }

  /**
   * Remove a token at runtime.
   */
  removeToken(token: string): void {
    this.tokens.delete(token);
    this.logger.info('Auth token removed');
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }

  private cleanupStaleEntries(now: number, windowMs: number): void {
    for (const [ip, hits] of this.ipHits) {
      const fresh = hits.filter(t => now - t < windowMs);
      if (fresh.length === 0) {
        this.ipHits.delete(ip);
      } else if (fresh.length !== hits.length) {
        this.ipHits.set(ip, fresh);
      }
    }
  }
}
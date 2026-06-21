/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — HTTP Request
 *
 * Raw HTTP client for API integrations.
 * Supports GET, POST, PUT, PATCH, DELETE with headers, body, and timeout.
 * Retries on 429 (Too Many Requests) and 503 (Service Unavailable) with
 * exponential backoff (1s, 2s, 4s), respecting Retry-After header.
 * Uses native fetch. Body truncated to 50KB.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface HttpRequestConfig {
  /** Default timeout in ms (default: 15000) */
  defaultTimeout?: number;
  /** Max response body size to return (default: 50KB) */
  maxBodySize?: number;
  /** Max retry attempts for 429/503 (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseRetryDelay?: number;
}

/** Status codes that trigger retry */
const RETRYABLE_STATUS = new Set([429, 503]);

export class HttpRequestTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'http',
    name: 'HTTP Request',
    description: 'Make an HTTP request to any URL. Supports GET, POST, PUT, PATCH, DELETE with custom headers and body. Retries on 429 and 503 with exponential backoff.',
    parameters: [
      { name: 'method', type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, or DELETE', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', type: 'string', description: 'HTTP(S) URL to request', required: true },
      { name: 'headers', type: 'object', description: 'Request headers as key-value pairs', required: false, properties: {} },
      { name: 'body', type: 'string', description: 'Request body (for POST/PUT/PATCH)', required: false },
      { name: 'timeout', type: 'number', description: 'Timeout in ms (default: 15000)', required: false, default: 15000 },
      { name: 'maxRetries', type: 'number', description: 'Max retry attempts for 429/503 (default: 3)', required: false, default: 3 },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 30000,
  };

  private config: Required<HttpRequestConfig>;

  constructor(config: HttpRequestConfig = {}) {
    this.config = {
      defaultTimeout: config.defaultTimeout ?? 15000,
      maxBodySize: config.maxBodySize ?? 50 * 1024,
      maxRetries: config.maxRetries ?? 3,
      baseRetryDelay: config.baseRetryDelay ?? 1000,
    };
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const method = (params.method as string).toUpperCase();
    const url = params.url as string;
    const headers = (params.headers as Record<string, string>) || {};
    const body = params.body as string | undefined;
    const timeout = (params.timeout as number) || this.config.defaultTimeout;
    const maxRetries = (params.maxRetries as number) ?? this.config.maxRetries;
    const start = Date.now();

    // Validate method
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!validMethods.includes(method)) {
      return {
        success: false,
        data: null,
        summary: `Invalid HTTP method: ${method}`,
        error: `'${method}' is not a valid method. Valid methods: ${validMethods.join(', ')}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return {
        success: false,
        data: null,
        summary: `Invalid URL: ${url}`,
        error: `'${url}' is not a valid HTTP(S) URL`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    let lastError: string | undefined;
    let attempt = 0;

    for (attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchOptions: RequestInit = {
          method,
          headers: { 'User-Agent': 'Lodestone/0.1 (agent runtime)', ...headers },
          signal: controller.signal,
        };

        if (body && method !== 'GET') {
          fetchOptions.body = body;
        }

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        // Check if we should retry
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          // Parse Retry-After header (seconds or HTTP-date)
          const retryAfter = res.headers.get('Retry-After');
          let delayMs: number;

          if (retryAfter) {
            // Try parsing as seconds first
            const asSeconds = parseInt(retryAfter, 10);
            if (!isNaN(asSeconds)) {
              delayMs = asSeconds * 1000;
            } else {
              // Try parsing as HTTP-date
              const asDate = Date.parse(retryAfter);
              if (!isNaN(asDate)) {
                delayMs = Math.max(0, asDate - Date.now());
              } else {
                delayMs = this.config.baseRetryDelay * Math.pow(2, attempt);
              }
            }
          } else {
            // Exponential backoff: 1s, 2s, 4s
            delayMs = this.config.baseRetryDelay * Math.pow(2, attempt);
          }

          context.log.warn(`HTTP ${res.status} on ${method} ${url}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);

          // Read the body for error reporting before retrying
          const errorBody = await res.text();
          lastError = `HTTP ${res.status} ${res.statusText} — ${errorBody.slice(0, 200)}`;

          await this.sleep(delayMs);
          continue;
        }

        // Non-retryable or final attempt — return the response
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const rawBody = await res.text();
        const truncatedBody = rawBody.length > this.config.maxBodySize
          ? rawBody.slice(0, this.config.maxBodySize) + '\n...[truncated]'
          : rawBody;

        const attempts = attempt + 1;
        const retryNote = attempts > 1 ? ` (after ${attempts} attempts)` : '';

        return {
          success: res.ok,
          data: {
            status: res.status,
            statusText: res.statusText,
            headers: responseHeaders,
            body: truncatedBody,
            attempts,
          },
          summary: `${method} ${url} → ${res.status} ${res.statusText} (${rawBody.length} bytes)${retryNote}`,
          error: res.ok
            ? undefined
            : `HTTP ${res.status} ${res.statusText} from ${url}${retryNote} — response: ${rawBody.slice(0, 300)}`,
          durationMs: Date.now() - start,
          includeInContext: true,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Network errors and aborts — retry if we have attempts left
        if (attempt < maxRetries) {
          const delayMs = this.config.baseRetryDelay * Math.pow(2, attempt);
          context.log.warn(`HTTP request error on ${method} ${url}: ${errMsg}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
          lastError = errMsg;
          await this.sleep(delayMs);
          continue;
        }

        // Final attempt failed
        return {
          success: false,
          data: null,
          summary: `HTTP ${method} ${url} failed after ${attempt + 1} attempts: ${errMsg}`,
          error: `HTTP request to ${url} failed: ${errMsg}`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
    }

    // Exhausted all retries (shouldn't reach here, but just in case)
    return {
      success: false,
      data: null,
      summary: `HTTP ${method} ${url} failed after ${maxRetries + 1} attempts`,
      error: lastError ?? 'Unknown error after all retries exhausted',
      durationMs: Date.now() - start,
      includeInContext: false,
    };
  }

  /** Sleep helper for retry backoff */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
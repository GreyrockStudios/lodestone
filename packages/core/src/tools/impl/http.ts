/**
 * Lodestone Tool — HTTP Request
 *
 * Raw HTTP client for API integrations.
 * Supports GET, POST, PUT, PATCH, DELETE with headers, body, and timeout.
 * Uses native fetch. Body truncated to 50KB.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface HttpRequestConfig {
  /** Default timeout in ms (default: 15000) */
  defaultTimeout?: number;
  /** Max response body size to return (default: 50KB) */
  maxBodySize?: number;
}

export class HttpRequestTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'http',
    name: 'HTTP Request',
    description: 'Make an HTTP request to any URL. Supports GET, POST, PUT, PATCH, DELETE with custom headers and body.',
    parameters: [
      { name: 'method', type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, or DELETE', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', type: 'string', description: 'HTTP(S) URL to request', required: true },
      { name: 'headers', type: 'object', description: 'Request headers as key-value pairs', required: false, properties: {} },
      { name: 'body', type: 'string', description: 'Request body (for POST/PUT/PATCH)', required: false },
      { name: 'timeout', type: 'number', description: 'Timeout in ms (default: 15000)', required: false, default: 15000 },
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
    };
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const method = (params.method as string).toUpperCase();
    const url = params.url as string;
    const headers = (params.headers as Record<string, string>) || {};
    const body = params.body as string | undefined;
    const timeout = (params.timeout as number) || this.config.defaultTimeout;
    const start = Date.now();

    // Validate method
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!validMethods.includes(method)) {
      return {
        success: false,
        data: null,
        summary: `Invalid method: ${method}`,
        error: `Valid methods: ${validMethods.join(', ')}`,
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
        error: 'InvalidURL',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

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

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const rawBody = await res.text();
      const truncatedBody = rawBody.length > this.config.maxBodySize
        ? rawBody.slice(0, this.config.maxBodySize) + '\n...[truncated]'
        : rawBody;

      return {
        success: res.ok,
        data: {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          body: truncatedBody,
        },
        summary: `${method} ${url} → ${res.status} ${res.statusText} (${rawBody.length} bytes)`,
        error: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `HTTP request failed: ${err}`,
        error: String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }
}
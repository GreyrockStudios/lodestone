/**
 * Lodestone — Dashboard API Server
 *
 * Lightweight HTTP server that exposes the agent's state via a REST API
 * and serves a static dashboard UI. Also supports WebSocket connections
 * at /ws for real-time push updates and SSE streaming for logs.
 *
 * Endpoints:
 *   GET /health              — Health check
 *   GET /api/status           — Agent status (uptime, model, channels)
 *   GET /api/safety/tiers     — Capability tier summary
 *   GET /api/safety/rules     — Active behavioral rules
 *   GET /api/safety/promotion — Memory promotion queue
 *   GET /api/safety/truth     — Truth-binding guard status
 *   GET /api/safety/intent    — Intent prediction stats
 *   GET /api/safety/quality   — Quality gate stats
 *   GET /api/improvement/predictions — Prediction journal
 *   GET /api/improvement/drift       — Latest drift report
 *   GET /api/improvement/rbt         — Latest RBT diagnosis
 *   GET /api/improvement/patches     — Self-patch queue
 *   GET /api/knowledge/stats         — Knowledge graph stats
 *   GET /api/knowledge/graph          — Knowledge graph (DOT format)
 *   GET /api/knowledge/node/:id       — Graph node details
 *   POST /api/knowledge/node           — Add graph node
 *   POST /api/knowledge/edge           — Add graph edge
 *   GET /api/memory/stats             — Memory system stats
 *   GET /api/logs                      — Recent logs (filterable)
 *   GET /api/logs/stream               — SSE log tail stream
 *
 * WebSocket:
 *   /ws — real-time event push (auth via first message)
 *
 * Dashboard served at / — static HTML/JS from dashboard/ directory.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { join, extname } from 'path';
import { readFile, stat } from 'fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { DashboardAuth, type AuthConfig } from './auth.js';
import { HealthChecker, type HealthReport, type HealthCheckOptions } from '../utils/health-checks.js';
import { LogViewer, type LogEntry, type LogQueryOptions } from './log-viewer.js';

// ─── Dashboard Event Types ──────────────────────────────────────────────────

export type DashboardEvent =
  | { type: 'agent.state'; data: Record<string, unknown> }
  | { type: 'message.new'; data: Record<string, unknown> }
  | { type: 'tool.called'; data: Record<string, unknown> }
  | { type: 'tool.completed'; data: Record<string, unknown> }
  | { type: 'safety.event'; data: Record<string, unknown> }
  | { type: 'improvement.event'; data: Record<string, unknown> }
  | { type: 'health.update'; data: Record<string, unknown> };

export interface DashboardConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to */
  host: string;
  /** Path to static dashboard files */
  dashboardDir: string;
  /** API token for authentication (if set) */
  apiToken?: string;
  /** CORS origin (default: *) */
  corsOrigin?: string;
  /** Auth configuration (tokens, rate limits) */
  auth?: AuthConfig;
  /** Path to log file for log viewer (if file logging is enabled) */
  logFile?: string;
}

interface RouteContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

type RouteHandler = (ctx: RouteContext) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; handler: RouteHandler; paramNames: string[] };

// ─── WebSocket Client ──────────────────────────────────────────────────────

interface WsClient {
  ws: WebSocket;
  authenticated: boolean;
}

// ─── Dashboard Server ────────────────────────────────────────────────────────

interface WebhookSystemLike {
  isWebhookPath(path: string): boolean;
  handleIncoming(path: string, body: Buffer | string, headers: Record<string, string>): Promise<{ status: string; message: string; action?: string; data?: unknown }>;
  listIncoming(): { path: string; provider: string; enabled: boolean }[];
  listOutgoing(): { event: string; url: string }[];
}

export class DashboardServer {
  private config: DashboardConfig;
  private server: ReturnType<typeof createServer> | null = null;
  private routes: Route[] = [];
  private dataProviders: Map<string, () => Promise<unknown>> = new Map();
  readonly auth: DashboardAuth;
  private healthChecker: HealthChecker;
  private healthOpts: HealthCheckOptions | null = null;

  // WebSocket support
  private wss: WebSocketServer | null = null;
  private wsClients: Set<WsClient> = new Set();

  // Log viewer
  private logViewer: LogViewer | null = null;

  // Webhook system (optional — set by engine if configured)
  private webhookSystem: WebhookSystemLike | null = null;

  constructor(config: DashboardConfig) {
    this.config = config;
    this.auth = new DashboardAuth(config.auth || {});
    this.healthChecker = new HealthChecker();

    // Initialize log viewer if log file path is configured
    if (config.logFile) {
      this.logViewer = new LogViewer(config.logFile);
    }

    // Register default routes
    this.registerRoutes();
  }

  /**
   * Register a data provider for the dashboard.
   * This lets the engine inject real data into the API endpoints.
   */
  registerProvider(name: string, provider: () => Promise<unknown>): void {
    this.dataProviders.set(name, provider);
  }

  /**
   * Set the webhook system for incoming webhook handling.
   */
  setWebhookSystem(webhookSystem: WebhookSystemLike): void {
    this.webhookSystem = webhookSystem;
  }

  /**
   * Set health check options so the /health endpoint can run real checks.
   */
  setHealthOptions(opts: HealthCheckOptions): void {
    this.healthOpts = opts;
  }

  /**
   * Get the current health report (delegated to HealthChecker).
   */
  async getHealth(): Promise<HealthReport> {
    if (!this.healthOpts) {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        checks: { channels: [] },
        overall: { total: 0, passed: 0, failed: 0 },
      };
    }
    return this.healthChecker.runAll(this.healthOpts);
  }

  /**
   * Start the dashboard server.
   */
  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });

    // Set up WebSocket server on the same HTTP server
    this.setupWebSocket();

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        // Dashboard started
        resolve();
      });
    });
  }

  /**
   * Stop the dashboard server.
   */
  async stop(): Promise<void> {
    // Close all WebSocket connections
    if (this.wss) {
      for (const client of this.wsClients) {
        try { client.ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
      }
      this.wsClients.clear();
      this.wss.close();
      this.wss = null;
    }

    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────

  /**
   * Set up WebSocket server on the same HTTP server, at /ws.
   */
  private setupWebSocket(): void {
    this.wss = new WebSocketServer({ noServer: true });

    this.server!.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleWsConnection(ws, req);
      });
    });
  }

  /**
   * Handle a new WebSocket connection.
   * Auth: client must send { type: 'auth', token: '...' } as first message.
   */
  private handleWsConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: WsClient = { ws, authenticated: false };

    // If auth is not enabled, mark as authenticated immediately
    if (!this.auth.enabled) {
      client.authenticated = true;
    }

    this.wsClients.add(client);

    // Auth timeout — close if not authenticated within 10s
    const authTimeout = setTimeout(() => {
      if (!client.authenticated) {
        try { ws.close(4001, 'Authentication timeout'); } catch { /* ignore */ }
        this.wsClients.delete(client);
      }
    }, 10_000);

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // First message must be auth
        if (!client.authenticated) {
          if (msg.type === 'auth' && typeof msg.token === 'string') {
            if (this.auth.validateToken(msg.token)) {
              client.authenticated = true;
              clearTimeout(authTimeout);
              ws.send(JSON.stringify({ type: 'auth.ok' }));
            } else {
              ws.send(JSON.stringify({ type: 'auth.error', reason: 'Invalid token' }));
              ws.close(4003, 'Invalid token');
              this.wsClients.delete(client);
            }
          } else {
            ws.send(JSON.stringify({ type: 'auth.error', reason: 'Send auth first' }));
          }
          return;
        }

        // Handle ping/keepalive
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      this.wsClients.delete(client);
    });

    ws.on('error', () => {
      clearTimeout(authTimeout);
      this.wsClients.delete(client);
    });

    // Send welcome message
    if (client.authenticated) {
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    } else {
      ws.send(JSON.stringify({ type: 'auth.required' }));
    }
  }

  /**
   * Broadcast an event to all connected WebSocket clients.
   */
  broadcast(event: DashboardEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.wsClients) {
      if (!client.authenticated) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(message);
        } catch {
          // Remove broken client
          this.wsClients.delete(client);
        }
      } else if (client.ws.readyState === WebSocket.CLOSED || client.ws.readyState === WebSocket.CLOSING) {
        this.wsClients.delete(client);
      }
    }
  }

  /**
   * Get the number of connected WebSocket clients.
   */
 getWsClientCount(): number {
    return this.wsClients.size;
  }

  // ─── Request Handling ────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // CORS headers
    const origin = this.config.corsOrigin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse cookies
    const cookieHeader = req.headers.cookie;
    const cookies = DashboardAuth.parseCookies(
      typeof cookieHeader === 'string' ? cookieHeader : undefined
    );

    // Parse query params
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    // ─── Public endpoints (no auth required) ───────────────────────────
    // Health endpoint — always public
    if (path === '/health') {
      const report = await this.getHealth();
      this.sendJson(res, 200, report);
      return;
    }

    // ─── Webhook endpoints (no auth — use own signature verification) ────
    if (path.startsWith('/webhooks/') && method === 'POST' && this.webhookSystem) {
      await this.handleWebhookRequest(req, res, path);
      return;
    }

    // Auth login endpoint — accepts a token, sets cookie
    if (path === '/api/auth/login' && method === 'POST') {
      await this.handleLogin(req, res, query, cookies);
      return;
    }

    // Auth status — check if auth is enabled and if current request is authenticated
    if (path === '/api/auth/status') {
      const authResult = this.auth.authenticate(req.headers as Record<string, string | string[] | undefined>, query, cookies);
      this.sendJson(res, 200, {
        authEnabled: this.auth.enabled,
        authenticated: authResult.authenticated,
      });
      return;
    }

    // ─── Rate limiting (applied to all /api/* routes) ──────────────────
    const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const rateLimit = this.auth.checkRateLimit(clientIp);
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());
    if (!rateLimit.allowed) {
      this.sendJson(res, 429, { error: 'Rate limit exceeded', retryMs: rateLimit.resetMs });
      return;
    }

    // ─── Auth middleware for /api/* routes ─────────────────────────────
    if (path.startsWith('/api/')) {
      // Legacy: support config.apiToken if auth not configured with tokens
      if (this.auth.enabled) {
        const authResult = this.auth.authenticate(
          req.headers as Record<string, string | string[] | undefined>,
          query,
          cookies,
        );
        if (!authResult.authenticated) {
          this.sendJson(res, 401, { error: 'Unauthorized', reason: authResult.reason });
          return;
        }
      } else if (this.config.apiToken) {
        // Legacy single-token fallback
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        // Also check cookie and query for legacy token
        const cookieToken = cookies.lodestone_token || cookies.auth_token;
        const queryToken = query.token;
        const providedToken = token || cookieToken || queryToken;
        if (providedToken !== this.config.apiToken) {
          this.sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
      }

      await this.handleApiRoute(method, path, url, res);
      return;
    }

    // Static files (dashboard) — no auth required to load the page
    await this.serveStatic(path, res);
  }

  /**
   * Handle auth login — accepts token via body or query, sets cookie.
   */
  private async handleLogin(
    req: IncomingMessage,
    res: ServerResponse,
    query: Record<string, string>,
    cookies: Record<string, string>,
  ): Promise<void> {
    // Try to get token from body
    let token: string | null = null;
    if (req.headers['content-type']?.includes('application/json')) {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        token = body.token || null;
      } catch {
        // Fall through to query/cookie
      }
    }
    if (!token) token = query.token || null;
    if (!token) token = cookies.lodestone_token || null;

    if (!token) {
      this.sendJson(res, 400, { error: 'No token provided' });
      return;
    }

    if (this.auth.validateToken(token)) {
      // Set cookie — valid for 7 days, HttpOnly, SameSite=Strict
      res.setHeader('Set-Cookie', `lodestone_token=${token}; HttpOnly; Max-Age=604800; SameSite=Strict; Path=/`);
      this.sendJson(res, 200, { success: true, message: 'Authenticated' });
    } else {
      this.sendJson(res, 401, { error: 'Invalid token' });
    }
  }

  /**
   * Handle incoming webhook requests — before auth, uses signature verification.
   */
  private async handleWebhookRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.webhookSystem) {
      this.sendJson(res, 404, { error: 'Webhooks not configured' });
      return;
    }

    // Collect headers (lowercase)
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v.length > 0) headers[k.toLowerCase()] = v[0];
    }

    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Resolve custom webhook paths: /webhooks/custom/:name → /webhooks/custom/:name
    let webhookPath = path;
    if (!this.webhookSystem.isWebhookPath(path) && path.startsWith('/webhooks/custom/')) {
      // Try matching as a generic custom webhook
      webhookPath = '/webhooks/custom/:name';
    }

    try {
      const result = await this.webhookSystem.handleIncoming(webhookPath, body, headers);
      this.sendJson(res, result.status === 'error' ? 400 : 200, result);
    } catch (err) {
      this.sendJson(res, 500, { error: 'Webhook handler error', message: String(err) });
    }
  }

  private async handleApiRoute(method: string, path: string, url: URL, res: ServerResponse): Promise<void> {
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    // ─── SSE streaming endpoint for logs ────────────────────────────
    if (path === '/api/logs/stream' && method === 'GET') {
      await this.handleLogStream(res);
      return;
    }

    // Match route
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = path.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });

      try {
        const result = await route.handler({ method, path, params, query, body: undefined });
        this.sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 500, { error: message });
      }
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  /**
   * SSE endpoint for streaming new log entries.
   */
  private async handleLogStream(res: ServerResponse): Promise<void> {
    if (!this.logViewer) {
      this.sendJson(res, 400, { error: 'Log file not configured' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial comment to establish connection
    res.write(': connected\n\n');

    // Tail logs and send as SSE events
    const stop = this.logViewer.tailLogs((entry: LogEntry) => {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        // Connection probably closed
        stop();
      }
    });

    // Clean up on client disconnect
    res.on('close', () => {
      stop();
    });
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<void> {
    // Serve index.html for /
    let filePath = path === '/' ? '/index.html' : path;
    filePath = join(this.config.dashboardDir, filePath);

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error(`Path '${filePath}' is not a file. Only files can be served.`);
      }

      const content = await readFile(filePath);
      const ext = extname(filePath);
      const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };

      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      // SPA fallback: serve index.html for unknown routes
      try {
        const content = await readFile(join(this.config.dashboardDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        this.sendJson(res, 404, { error: 'Dashboard not found' });
      }
    }
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  // ─── Route Registration ────────────────────────────────────────────────────

  private registerRoutes(): void {
    this.addRoute('GET', /^\/api\/status$/, async () => {
      const provider = this.dataProviders.get('status');
      return provider ? await provider() : { status: 'running', uptime: process.uptime() };
    });

    this.addRoute('GET', /^\/api\/safety\/tiers$/, async () => {
      const provider = this.dataProviders.get('safety.tiers');
      return provider ? await provider() : { tiers: {} };
    });

    this.addRoute('GET', /^\/api\/safety\/rules$/, async () => {
      const provider = this.dataProviders.get('safety.rules');
      return provider ? await provider() : { rules: [] };
    });

    this.addRoute('GET', /^\/api\/safety\/promotion$/, async () => {
      const provider = this.dataProviders.get('safety.promotion');
      return provider ? await provider() : { queue: [], stats: {} };
    });

    this.addRoute('GET', /^\/api\/safety\/truth$/, async () => {
      const provider = this.dataProviders.get('safety.truth');
      return provider ? await provider() : { guards: [] };
    });

    this.addRoute('GET', /^\/api\/safety\/intent$/, async () => {
      const provider = this.dataProviders.get('safety.intent');
      return provider ? await provider() : { stats: {}, recent: [] };
    });

    this.addRoute('GET', /^\/api\/safety\/quality$/, async () => {
      const provider = this.dataProviders.get('safety.quality');
      return provider ? await provider() : { recentDecisions: {}, avgScores: {} };
    });

    this.addRoute('GET', /^\/api\/improvement\/predictions$/, async () => {
      const provider = this.dataProviders.get('improvement.predictions');
      return provider ? await provider() : { predictions: [] };
    });

    this.addRoute('GET', /^\/api\/improvement\/drift$/, async () => {
      const provider = this.dataProviders.get('improvement.drift');
      return provider ? await provider() : { report: null };
    });

    this.addRoute('GET', /^\/api\/improvement\/rbt$/, async () => {
      const provider = this.dataProviders.get('improvement.rbt');
      return provider ? await provider() : { report: null };
    });

    this.addRoute('GET', /^\/api\/improvement\/patches$/, async () => {
      const provider = this.dataProviders.get('improvement.patches');
      return provider ? await provider() : { patches: [], stats: {} };
    });

    this.addRoute('GET', /^\/api\/knowledge\/stats$/, async () => {
      const provider = this.dataProviders.get('knowledge.stats');
      return provider ? await provider() : { nodeCount: 0, edgeCount: 0 };
    });

    this.addRoute('GET', /^\/api\/knowledge\/graph$/, async () => {
      const provider = this.dataProviders.get('knowledge.graph');
      return provider ? await provider() : { dot: 'digraph {}' };
    });

    this.addRoute('GET', /^\/api\/knowledge\/node\/(.+)$/, ['id'], async (ctx) => {
      const provider = this.dataProviders.get('knowledge.node');
      return provider ? await provider() : { node: null };
    });

    this.addRoute('GET', /^\/api\/memory\/stats$/, async () => {
      const provider = this.dataProviders.get('memory.stats');
      return provider ? await provider() : { wiki: 0, vector: 0, scratch: 0 };
    });

    // ─── Log viewer routes ────────────────────────────────────────────
    this.addRoute('GET', /^\/api\/logs$/, async (ctx: RouteContext) => {
      if (!this.logViewer) {
        return { error: 'Log file not configured', entries: [] };
      }
      const opts: LogQueryOptions = {};
      if (ctx.query.limit) opts.limit = parseInt(ctx.query.limit, 10);
      if (ctx.query.level) opts.level = ctx.query.level;
      if (ctx.query.module) opts.module = ctx.query.module;
      if (ctx.query.since) {
        const since = new Date(ctx.query.since);
        if (!isNaN(since.getTime())) opts.since = since;
      }
      const entries = await this.logViewer.getRecentLogs(opts);
      return { entries, count: entries.length };
    });

    this.addRoute('GET', /^\/api\/logs\/modules$/, async () => {
      if (!this.logViewer) {
        return { modules: [] };
      }
      const modules = await this.logViewer.getModules();
      return { modules };
    });

    // ─── Explainability trace routes ──────────────────────────────────
    this.addRoute('GET', /^\/api\/traces$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('explainability.traces');
      if (provider) {
        return await provider();
      }
      return { traces: [], count: 0 };
    });

    this.addRoute('GET', /^\/api\/traces\/([^/]+)$/, ['id'], async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('explainability.trace');
      if (provider) {
        return await provider();
      }
      return { trace: null };
    });

    // ─── Cost tracking routes ──────────────────────────────────────────
    this.addRoute('GET', /^\/api\/costs$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('costs.summary');
      if (provider) return await provider();
      return { error: 'Cost tracking not configured' };
    });

    this.addRoute('GET', /^\/api\/costs\/daily$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('costs.daily');
      if (provider) return await provider();
      return { error: 'Cost tracking not configured' };
    });

    this.addRoute('GET', /^\/api\/costs\/weekly$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('costs.weekly');
      if (provider) return await provider();
      return { error: 'Cost tracking not configured' };
    });

    this.addRoute('GET', /^\/api\/costs\/monthly$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('costs.monthly');
      if (provider) return await provider();
      return { error: 'Cost tracking not configured' };
    });

    this.addRoute('GET', /^\/api\/costs\/session\/([^/]+)$/, ['sessionId'], async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('costs.session');
      if (provider) return await provider();
      return { error: 'Cost tracking not configured' };
    });

    this.addRoute('GET', /^\/api\/costs\/export$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('costs.export');
      if (provider) return await provider();
      return { error: 'Cost tracking not configured' };
    });

    // ─── Model routing stats ──────────────────────────────────────────
    this.addRoute('GET', /^\/api\/routing\/stats$/, async (ctx: RouteContext) => {
      const provider = this.dataProviders.get('routing.stats');
      if (provider) return await provider();
      return { error: 'Model routing not configured' };
    });
  }

  private addRoute(method: string, pattern: RegExp, paramNamesOrHandler: string[] | RouteHandler, handler?: RouteHandler): void {
    if (typeof paramNamesOrHandler === 'function') {
      handler = paramNamesOrHandler as RouteHandler;
      paramNamesOrHandler = [];
    }
    this.routes.push({ method, pattern, handler: handler as RouteHandler, paramNames: paramNamesOrHandler as string[] });
  }

  /** Get the server port */
  get port(): number {
    return this.config.port;
  }

  /** Get the server host */
  get host(): string {
    return this.config.host;
  }
}
/**
 * Lodestone — Webhook System
 *
 * Incoming webhooks trigger agent actions (GitHub, Slack, custom).
 * Outgoing webhooks fire on engine events (message, tool, safety, failure).
 * Signature verification: HMAC-SHA256 for GitHub, Slack signing secret.
 * Uses built-in crypto — no extra dependencies.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { Logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type WebhookHandler = (event: string, payload: unknown, headers: Record<string, string>) => Promise<WebhookResponse>;

export interface WebhookResponse {
  status: 'ok' | 'error' | 'ignored';
  message: string;
  action?: string;
  data?: unknown;
}

export interface WebhookOpts {
  /** Secret for signature verification */
  secret?: string;
  /** Custom headers to send */
  headers?: Record<string, string>;
  /** Timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Only fire if payload matches filter (simple deep-equal check on subset) */
  filter?: Record<string, unknown>;
}

export interface WebhookConfig {
  path: string;
  /** Provider type for built-in handlers */
  provider: 'github' | 'slack' | 'custom';
  /** Secret for signature verification */
  secret?: string;
  /** Whether this webhook is active */
  enabled?: boolean;
}

export interface OutgoingWebhookConfig {
  /** Event name to listen for */
  event: string;
  /** URL to POST to */
  url: string;
  /** Secret for signing the payload */
  secret?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Timeout in ms */
  timeoutMs?: number;
  /** Filter — only fire if event data matches */
  filter?: Record<string, unknown>;
}

// ─── Incoming Webhook Registration ─────────────────────────────────────────

interface IncomingWebhook {
  path: string;
  handler: WebhookHandler;
  secret?: string;
  provider: string;
  enabled: boolean;
}

interface OutgoingWebhook {
  event: string;
  url: string;
  secret?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  filter?: Record<string, unknown>;
}

// ─── Webhook System ────────────────────────────────────────────────────────

export class WebhookSystem {
  private log: Logger;
  private incoming: Map<string, IncomingWebhook> = new Map();
  private outgoing: Map<string, OutgoingWebhook[]> = new Map();
  private actionCallback: ((action: string, payload: unknown) => Promise<void>) | null = null;

  constructor(config?: { incoming?: WebhookConfig[]; outgoing?: OutgoingWebhookConfig[] }) {
    this.log = new Logger({ minLevel: 'info' });

    // Register configured incoming webhooks
    if (config?.incoming) {
      for (const wh of config.incoming) {
        if (wh.enabled === false) continue;
        if (wh.provider === 'github') {
          this.registerGitHubWebhook(wh.path, wh.secret);
        } else if (wh.provider === 'slack') {
          this.registerSlackWebhook(wh.path, wh.secret);
        } else {
          this.registerCustomWebhook(wh.path, async (event, payload) => ({
            status: 'ok' as const,
            message: `Custom webhook received: ${event}`,
            action: `webhook.${wh.path.replace(/^\//, '').replace(/\//g, '.')}`,
            data: payload,
          }), wh.secret);
        }
      }
    }

    // Register configured outgoing webhooks
    if (config?.outgoing) {
      for (const ow of config.outgoing) {
        this.registerOutgoing(ow.event, ow.url, {
          secret: ow.secret,
          headers: ow.headers,
          timeoutMs: ow.timeoutMs,
          filter: ow.filter,
        });
      }
    }
  }

  /**
   * Set the callback for triggering agent actions from incoming webhooks.
   */
  onAction(callback: (action: string, payload: unknown) => Promise<void>): void {
    this.actionCallback = callback;
  }

  // ─── Incoming Webhooks ──────────────────────────────────────────────────

  /**
   * Register an incoming webhook endpoint.
   */
  registerIncoming(path: string, handler: WebhookHandler, opts?: { secret?: string; provider?: string }): void {
    const provider = opts?.provider || 'custom';
    this.incoming.set(path, {
      path,
      handler,
      secret: opts?.secret,
      provider,
      enabled: true,
    });
    this.log.info(`[Webhooks] Registered incoming: ${path} (${provider})`);
  }

  /**
   * Register a built-in GitHub webhook handler.
   */
  registerGitHubWebhook(path: string, secret?: string): void {
    this.registerIncoming(path, this.githubHandler.bind(this), { secret, provider: 'github' });
  }

  /**
   * Register a built-in Slack webhook handler.
   */
  registerSlackWebhook(path: string, secret?: string): void {
    this.registerIncoming(path, this.slackHandler.bind(this), { secret, provider: 'slack' });
  }

  /**
   * Register a generic custom webhook handler.
   */
  registerCustomWebhook(path: string, handler: WebhookHandler, secret?: string): void {
    this.registerIncoming(path, handler, { secret, provider: 'custom' });
  }

  /**
   * Handle an incoming webhook request.
   * Called by the dashboard server when a POST hits a webhook path.
   */
  async handleIncoming(
    path: string,
    body: Buffer | string,
    headers: Record<string, string>
  ): Promise<WebhookResponse> {
    const webhook = this.incoming.get(path);
    if (!webhook) {
      return { status: 'error', message: `No webhook registered at path: ${path}` };
    }
    if (!webhook.enabled) {
      return { status: 'ignored', message: `Webhook at ${path} is disabled` };
    }

    // Verify signature
    if (webhook.secret) {
      if (!this.verifySignature(webhook.provider, webhook.secret, body, headers)) {
        this.log.warn(`[Webhooks] Signature verification failed: ${path}`);
        return { status: 'error', message: 'Signature verification failed' };
      }
    }

    // Parse body
    let payload: unknown;
    try {
      const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
      payload = JSON.parse(bodyStr);
    } catch {
      // Non-JSON payload — pass as string
      payload = typeof body === 'string' ? body : body.toString('utf-8');
    }

    const event = headers['x-github-event'] || headers['x-slack-event'] || 'unknown';

    try {
      const response = await webhook.handler(event, payload, headers);

      // If the handler returned an action, trigger it
      if (response.action && this.actionCallback) {
        await this.actionCallback(response.action, response.data || payload);
      }

      this.log.info(`[Webhooks] Incoming ${path}: ${response.status} — ${response.message}`);
      return response;
    } catch (err) {
      this.log.error(`[Webhooks] Handler error at ${path}: ${err}`);
      return { status: 'error', message: String(err) };
    }
  }

  /**
   * Check if a path is a registered webhook endpoint.
   */
  isWebhookPath(path: string): boolean {
    // Check exact match or pattern match for custom/:name
    if (this.incoming.has(path)) return true;
    // Check pattern: /webhooks/custom/:name
    if (path.startsWith('/webhooks/custom/')) {
      // Any custom webhook path is handled
      return this.incoming.has('/webhooks/custom/:name') ||
             Array.from(this.incoming.keys()).some(k =>
               k.startsWith('/webhooks/custom/') && path.startsWith(k.split(':')[0])
             );
    }
    return false;
  }

  /**
   * List all registered incoming webhooks.
   */
  listIncoming(): { path: string; provider: string; enabled: boolean }[] {
    return Array.from(this.incoming.values()).map(w => ({
      path: w.path,
      provider: w.provider,
      enabled: w.enabled,
    }));
  }

  // ─── Outgoing Webhooks ──────────────────────────────────────────────────

  /**
   * Register an outgoing webhook for an event.
   */
  registerOutgoing(event: string, url: string, opts?: WebhookOpts): void {
    const webhooks = this.outgoing.get(event) || [];
    webhooks.push({
      event,
      url,
      secret: opts?.secret,
      headers: opts?.headers || {},
      timeoutMs: opts?.timeoutMs || 10000,
      filter: opts?.filter,
    });
    this.outgoing.set(event, webhooks);
    this.log.info(`[Webhooks] Registered outgoing: ${event} → ${url}`);
  }

  /**
   * Trigger all outgoing webhooks for an event.
   */
  async triggerOutgoing(event: string, payload: unknown): Promise<void> {
    const webhooks = this.outgoing.get(event);
    if (!webhooks || webhooks.length === 0) return;

    const promises = webhooks.map(async (wh) => {
      // Check filter
      if (wh.filter && !this.matchesFilter(payload, wh.filter)) {
        return; // Skip — doesn't match filter
      }

      try {
        const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...wh.headers,
        };

        // Sign payload if secret is set
        if (wh.secret) {
          const signature = createHmac('sha256', wh.secret).update(body).digest('hex');
          headers['X-Lodestone-Signature'] = `sha256=${signature}`;
          headers['X-Lodestone-Event'] = event;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), wh.timeoutMs);

        const response = await fetch(wh.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          this.log.warn(`[Webhooks] Outgoing ${event} → ${wh.url} failed: ${response.status}`);
        } else {
          this.log.debug(`[Webhooks] Outgoing ${event} → ${wh.url} delivered (${response.status})`);
        }
      } catch (err) {
        this.log.warn(`[Webhooks] Outgoing ${event} → ${wh.url} error: ${err}`);
      }
    });

    await Promise.all(promises);
  }

  /**
   * List all registered outgoing webhooks.
   */
  listOutgoing(): { event: string; url: string }[] {
    const result: { event: string; url: string }[] = [];
    for (const [event, webhooks] of this.outgoing.entries()) {
      for (const wh of webhooks) {
        result.push({ event, url: wh.url });
      }
    }
    return result;
  }

  // ─── Built-in Handlers ──────────────────────────────────────────────────

  /**
   * GitHub webhook handler — handles push, PR, issue events.
   */
  private async githubHandler(event: string, payload: unknown, _headers: Record<string, string>): Promise<WebhookResponse> {
    const p = payload as Record<string, unknown> | undefined;
    switch (event) {
      case 'push':
        return {
          status: 'ok',
          message: `Push to ${(p?.repository as { full_name?: string })?.full_name}: ${(p?.head_commit as { message?: string })?.message || 'no message'}`,
          action: 'github.push',
          data: {
            repo: (p?.repository as { full_name?: string })?.full_name,
            branch: p?.ref,
            commits: (p?.commits as unknown[])?.length || 0,
            message: (p?.head_commit as { message?: string })?.message,
          },
        };

      case 'pull_request':
        return {
          status: 'ok',
          message: `PR #${p?.number} ${p?.action}: ${(p?.pull_request as { title?: string })?.title}`,
          action: `github.pr.${p?.action}`,
          data: {
            repo: (p?.repository as { full_name?: string })?.full_name,
            prNumber: p?.number,
            action: p?.action,
            title: (p?.pull_request as { title?: string })?.title,
            author: (p?.pull_request as { user: { login?: string } })?.user?.login,
            url: (p?.pull_request as { html_url?: string })?.html_url,
          },
        };

      case 'issues':
        return {
          status: 'ok',
          message: `Issue #${(p?.issue as { number?: number })?.number} ${p?.action}: ${(p?.issue as { title?: string })?.title}`,
          action: `github.issue.${p?.action}`,
          data: {
            repo: (p?.repository as { full_name?: string })?.full_name,
            issueNumber: (p?.issue as { number?: number })?.number,
            action: p?.action,
            title: (p?.issue as { title?: string })?.title,
            author: (p?.issue as { user: { login?: string } })?.user?.login,
            url: (p?.issue as { html_url?: string })?.html_url,
          },
        };

      case 'issue_comment':
        return {
          status: 'ok',
          message: `Comment on #${(p?.issue as { number?: number })?.number}: ${(p?.comment as { body?: string })?.body?.slice(0, 100)}`,
          action: 'github.comment',
          data: {
            repo: (p?.repository as { full_name?: string })?.full_name,
            issueNumber: (p?.issue as { number?: number })?.number,
            body: (p?.comment as { body?: string })?.body,
            author: (p?.comment as { user: { login?: string } })?.user?.login,
          },
        };

      default:
        return {
          status: 'ignored',
          message: `Unhandled GitHub event: ${event}`,
        };
    }
  }

  /**
   * Slack webhook handler — handles slash commands and mentions.
   */
  private async slackHandler(_event: string, payload: unknown, _headers: Record<string, string>): Promise<WebhookResponse> {
    const p = payload as Record<string, unknown> | undefined;
    // Slash command
    if (p?.command) {
      return {
        status: 'ok',
        message: `Slack command: ${p.command} ${p.text || ''}`,
        action: 'slack.command',
        data: {
          command: p.command,
          text: p.text,
          userId: p.user_id,
          channelId: p.channel_id,
          responseUrl: p.response_url,
        },
      };
    }

    // Event mention or message
    if (p?.type === 'event_callback' && p.event) {
      const evt = p.event as Record<string, unknown>;
      if (evt.type === 'app_mention') {
        return {
          status: 'ok',
          message: `Slack mention from ${evt.user}: ${(evt.text as string)?.slice(0, 100)}`,
          action: 'slack.mention',
          data: {
            text: evt.text,
            user: evt.user,
            channel: evt.channel,
            ts: evt.ts,
          },
        };
      }
      if (evt.type === 'message') {
        return {
          status: 'ok',
          message: `Slack message in ${evt.channel}: ${(evt.text as string)?.slice(0, 100)}`,
          action: 'slack.message',
          data: {
            text: evt.text,
            user: evt.user,
            channel: evt.channel,
            ts: evt.ts,
          },
        };
      }
    }

    // URL verification challenge
    if (p?.type === 'url_verification') {
      return {
        status: 'ok',
        message: 'URL verification',
        data: { challenge: p.challenge },
      };
    }

    return {
      status: 'ignored',
      message: `Unhandled Slack event type: ${p?.type || 'unknown'}`,
    };
  }

  // ─── Signature Verification ─────────────────────────────────────────────

  /**
   * Verify webhook signature using HMAC-SHA256.
   * GitHub: X-Hub-Signature-256 header = "sha256=<hex>"
   * Slack: X-Slack-Signature header = "v0=<hex>" with timestamp
   */
  private verifySignature(
    provider: string,
    secret: string,
    body: Buffer | string,
    headers: Record<string, string>,
  ): boolean {
    const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');

    if (provider === 'github') {
      const sig = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'];
      if (!sig) return false;
      const expected = createHmac('sha256', secret).update(bodyStr).digest('hex');
      const provided = sig.replace(/^sha256=/, '');
      return this.safeCompare(expected, provided);
    }

    if (provider === 'slack') {
      const sig = headers['x-slack-signature'] || headers['X-Slack-Signature'];
      const timestamp = headers['x-slack-request-timestamp'] || headers['X-Slack-Request-Timestamp'];
      if (!sig || !timestamp) return false;

      // Slack signature: v0 = base HMAC of "v0:timestamp:body"
      const base = `v0:${timestamp}:${bodyStr}`;
      const expected = createHmac('sha256', secret).update(base).digest('hex');
      const provided = sig.replace(/^v0=/, '');
      return this.safeCompare(expected, provided);
    }

    // Custom: use X-Webhook-Signature with HMAC-SHA256 of body
    const sig = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
    if (!sig) return false;
    const expected = createHmac('sha256', secret).update(bodyStr).digest('hex');
    const provided = sig.replace(/^sha256=/, '');
    return this.safeCompare(expected, provided);
  }

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }

  private matchesFilter(payload: unknown, filter: Record<string, unknown>): boolean {
    const p = payload as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(filter)) {
      if (p?.[key] !== value) return false;
    }
    return true;
  }
}
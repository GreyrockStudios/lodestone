/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Email Channel
 *
 * IMAP polling for incoming emails, SMTP for outgoing via nodemailer.
 * Thread awareness groups emails by subject/thread-id.
 * Draft/review/send workflow: agent drafts → human reviews → sends.
 *
 * Note: nodemailer is required for SMTP. Install with: npm install nodemailer
 * If not installed, SMTP operations will log a warning and no-op.
 */

import { Channel, type ChannelConfig, type ChannelMessage } from './channel.js';
import { Logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  threadId: string;
  date: Date;
}

export interface EmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  status: 'draft' | 'approved' | 'sent' | 'rejected';
  createdAt: Date;
  threadId?: string;
  rejectionReason?: string;
}

export interface EmailThread {
  id: string;
  subject: string;
  messages: EmailMessage[];
}

export interface EmailHealthDetails {
  connected: boolean;
  imapConnected: boolean;
  smtpConnected: boolean;
  lastPollAt: Date | null;
  lastError: string | null;
  pendingDrafts: number;
}

// ─── Email Config ──────────────────────────────────────────────────────────

export interface EmailConfig extends ChannelConfig {
  type: 'email';
  imap: {
    host: string;
    port: number;
    secure?: boolean;
    user: string;
    password: string;
    /** Mailbox to poll (default: INBOX) */
    mailbox?: string;
  };
  smtp: {
    host: string;
    port: number;
    secure?: boolean;
    user: string;
    password: string;
    from: string;
  };
  /** Polling interval in ms (default: 5 min) */
  pollIntervalMs?: number;
  /** Maximum emails to fetch per poll (default: 50) */
  maxFetchPerPoll?: number;
}

// ─── Email Channel ──────────────────────────────────────────────────────────

export class EmailChannel extends Channel {
  private log: Logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap library loaded dynamically, no local types
  private imapConnection: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nodemailer loaded dynamically, no local types
  private smtpTransport: any = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private drafts: Map<string, EmailDraft> = new Map();
  private threads: Map<string, EmailThread> = new Map();
  private seenIds: Set<string> = new Set();
  private lastPollAt: Date | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxFetchPerPoll: number;
  private readonly mailbox: string;

  constructor(config: EmailConfig) {
    super(config);
    this.log = new Logger({ minLevel: 'info' });
    this.pollIntervalMs = config.pollIntervalMs ?? 5 * 60 * 1000;
    this.maxFetchPerPoll = config.maxFetchPerPoll ?? 50;
    this.mailbox = config.imap.mailbox ?? 'INBOX';
  }

  get id(): string {
    const user = (this.config as EmailConfig).imap.user;
    return `email:${user}@${(this.config as EmailConfig).imap.host}`;
  }

  get name(): string {
    return 'Email';
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    await this.connect();
    this.startPolling();
    this.running = true;
    this.log.info(`[Channel:Email] Started — ${this.id}, polling every ${this.pollIntervalMs}ms`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Disconnect IMAP
    if (this.imapConnection) {
      try {
        await this.imapConnection.end();
      } catch {
        // Best-effort close
      }
      this.imapConnection = null;
    }

    // Close SMTP
    if (this.smtpTransport) {
      try {
        this.smtpTransport.close();
      } catch {
        // Best-effort close
      }
      this.smtpTransport = null;
    }

    this.running = false;
    this.log.info(`[Channel:Email] Stopped — ${this.id}`);
  }

  // ─── Connection Management ──────────────────────────────────────────────

  /**
   * Connect to IMAP and SMTP servers.
   * IMAP uses the `imap` library (loaded dynamically).
   * SMTP uses `nodemailer` (loaded dynamically).
   */
  async connect(): Promise<void> {
    const cfg = this.config as EmailConfig;

    // Connect SMTP via nodemailer
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nodemailer loaded dynamically
      const nodemailer = await this.tryImport('nodemailer') as any;
      this.smtpTransport = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure ?? (cfg.smtp.port === 465),
        auth: {
          user: cfg.smtp.user,
          pass: cfg.smtp.password,
        },
      });
      await this.smtpTransport.verify();
      this.log.info(`[Channel:Email] SMTP connected — ${cfg.smtp.host}:${cfg.smtp.port}`);
    } catch (err) {
      this.log.warn(`[Channel:Email] SMTP connection failed: ${err}. Install nodemailer: npm install nodemailer`);
      this.smtpTransport = null;
    }

    // Connect IMAP via imap library
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap loaded dynamically
      const Imap = await this.tryImport('imap') as any;
      this.imapConnection = new Imap.default({
        user: cfg.imap.user,
        password: cfg.imap.password,
        host: cfg.imap.host,
        port: cfg.imap.port,
        tls: cfg.imap.secure ?? (cfg.imap.port === 993),
        connTimeout: 10000,
      });

      await new Promise<void>((resolve, reject) => {
        this.imapConnection.once('ready', resolve);
        this.imapConnection.once('error', reject);
        this.imapConnection.connect();
      });
      this.log.info(`[Channel:Email] IMAP connected — ${cfg.imap.host}:${cfg.imap.port}`);
    } catch (err) {
      this.log.warn(`[Channel:Email] IMAP connection failed: ${err}. Install imap: npm install imap`);
      this.imapConnection = null;
    }
  }

  // ─── Polling ─────────────────────────────────────────────────────────────

  /**
   * Poll IMAP for new emails. Returns new messages not yet seen.
   */
  async poll(): Promise<EmailMessage[]> {
    this.lastPollAt = new Date();

    if (!this.imapConnection) {
      this.log.warn('[Channel:Email] Cannot poll — IMAP not connected');
      return [];
    }

    try {
      const messages = await this.fetchNewMessages();
      this.lastError = null;

      // Group into threads and emit as channel messages
      for (const msg of messages) {
        this.addToThread(msg);
        this.seenIds.add(msg.id);

        // Emit as channel message for the agent loop
        const channelMessage: ChannelMessage = {
          sessionId: `email-${msg.threadId}`,
          content: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.body}`,
          senderId: msg.from,
          senderName: msg.from.split('@')[0],
          channelId: this.id,
          timestamp: msg.date.toISOString(),
          metadata: {
            emailId: msg.id,
            threadId: msg.threadId,
            subject: msg.subject,
            to: msg.to,
          },
        };
        await this.emitMessage(channelMessage);
      }

      return messages;
    } catch (err) {
      this.lastError = String(err);
      this.log.error(`[Channel:Email] Poll error: ${err}`);
      return [];
    }
  }

  /**
   * Start the polling timer. Called automatically by start().
   */
  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.poll().catch(err => {
        this.log.error(`[Channel:Email] Polling timer error: ${err}`);
      });
    }, this.pollIntervalMs);
  }

  // ─── Send / Draft / Review ───────────────────────────────────────────────

  /**
   * Send an email via SMTP.
   */
  async sendEmail(message: EmailMessage): Promise<void> {
    if (!this.smtpTransport) {
      this.log.warn('[Channel:Email] Cannot send — SMTP not connected');
      throw new Error('SMTP transport not available. Install nodemailer: npm install nodemailer. Also ensure SMTP credentials are configured in the email channel config.');
    }

    const cfg = this.config as EmailConfig;

    try {
      await this.smtpTransport.sendMail({
        from: cfg.smtp.from,
        to: Array.isArray(message.to) ? message.to.join(', ') : message.to,
        subject: message.subject,
        text: message.body,
      });
      this.log.info(`[Channel:Email] Sent: "${message.subject}" → ${message.to.join(', ')}`);
    } catch (err) {
      this.log.error(`[Channel:Email] Send failed: ${err}`);
      throw err;
    }
  }

  /**
   * Create a draft response. Does not send.
   * Agent drafts → human reviews → approveDraft sends.
   */
  draft(response: string, to: string, subject: string, threadId?: string): EmailDraft {
    const draftId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const d: EmailDraft = {
      id: draftId,
      to,
      subject,
      body: response,
      status: 'draft',
      createdAt: new Date(),
      threadId,
    };
    this.drafts.set(draftId, d);
    this.log.info(`[Channel:Email] Draft created: ${draftId} → "${subject}"`);
    return d;
  }

  /**
   * Approve and send a draft.
   */
  async approveDraft(draftId: string): Promise<void> {
    const d = this.drafts.get(draftId);
    if (!d) {
      throw new Error(`Email draft '${draftId}' not found. Use listDrafts() to see available drafts.`);
    }
    if (d.status !== 'draft') {
      throw new Error(`Email draft '${draftId}' is in '${d.status}' status, not 'draft'. Only drafts can be approved.`);
    }

    d.status = 'approved';

    const message: EmailMessage = {
      id: `sent-${Date.now()}`,
      from: (this.config as EmailConfig).smtp.from,
      to: [d.to],
      subject: d.subject,
      body: d.body,
      threadId: d.threadId || `sent-${Date.now()}`,
      date: new Date(),
    };

    await this.sendEmail(message);
    d.status = 'sent';
    this.log.info(`[Channel:Email] Draft approved & sent: ${draftId}`);
  }

  /**
   * Reject a draft with a reason.
   */
  rejectDraft(draftId: string, reason: string): void {
    const d = this.drafts.get(draftId);
    if (!d) {
      throw new Error(`Email draft '${draftId}' not found. Use listDrafts() to see available drafts.`);
    }
    d.status = 'rejected';
    d.rejectionReason = reason;
    this.log.info(`[Channel:Email] Draft rejected: ${draftId} — ${reason}`);
  }

  /**
   * Get all drafts.
   */
  getDrafts(): EmailDraft[] {
    return Array.from(this.drafts.values());
  }

  /**
   * Get all email threads.
   */
  getThreads(): EmailThread[] {
    return Array.from(this.threads.values()).sort(
      (a, b) => b.messages[b.messages.length - 1].date.getTime() - a.messages[a.messages.length - 1].date.getTime()
    );
  }

  /**
   * Get connection health.
   */
  getHealth(): import('./channel.js').ChannelHealth {
    const details: Record<string, unknown> = {
      connected: this.running,
      imapConnected: this.imapConnection !== null,
      smtpConnected: this.smtpTransport !== null,
      lastPollAt: this.lastPollAt,
      pendingDrafts: Array.from(this.drafts.values()).filter(d => d.status === 'draft').length,
    };
    return {
      status: this.running ? 'healthy' : 'down',
      active: this.running,
      messagesSent: this.messagesSent,
      messagesFailed: this.messagesFailed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0,
      details,
    };
  }

  // ─── Channel Base Class ─────────────────────────────────────────────────

  protected async sendRaw(sessionId: string, message: string): Promise<void> {
    // For Channel interface compatibility — send a simple message
    // Extract thread ID from session ID format "email-<threadId>"
    const threadId = sessionId.startsWith('email-') ? sessionId.slice(6) : sessionId;
    const cfg = this.config as EmailConfig;

    const msg: EmailMessage = {
      id: `sent-${Date.now()}`,
      from: cfg.smtp.from,
      to: [''], // Will be set from thread context
      subject: 'Re: ' + (this.threads.get(threadId)?.subject || ''),
      body: message,
      threadId,
      date: new Date(),
    };

    // Find the last sender in the thread
    const thread = this.threads.get(threadId);
    if (thread && thread.messages.length > 0) {
      msg.to = [thread.messages[thread.messages.length - 1].from];
    }

    await this.sendEmail(msg);
  }

  getMaxMessageLength(): number {
    return 0; // No hard limit for email
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically imported module, types not available locally
  private async tryImport(name: string): Promise<any> {
    try {
      return await import(name);
    } catch {
      throw new Error(`Package '${name}' is not installed. Install it with: npm install ${name}. This package is required for email channel functionality.`);
    }
  }

  private async fetchNewMessages(): Promise<EmailMessage[]> {
    return new Promise((resolve, reject) => {
      if (!this.imapConnection) {
        resolve([]);
        return;
      }

      const messages: EmailMessage[] = [];
      const imap = this.imapConnection;
      const cfg = this.config as EmailConfig;

      imap.openBox(this.mailbox, false, (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }

        // Search for all unseen messages
        imap.search(['UNSEEN'], (searchErr: Error | null, results: number[]) => {
          if (searchErr) {
            reject(searchErr);
            return;
          }
          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          // Limit to maxFetchPerPoll
          const uids = results.slice(0, this.maxFetchPerPoll);
          const f = imap.fetch(uids, { bodies: '', envelope: true, markSeen: true });
          let processed = 0;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap message events are untyped
          f.on('message', (msg: any) => {
            let buffer = '';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap envelope untyped
            let envelope: any;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap stream untyped
            msg.on('body', (stream: any) => {
              stream.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf-8');
              });
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap attrs untyped
            msg.on('attributes', (attrs: any) => {
              envelope = attrs.envelope;
            });

            msg.on('end', () => {
              const emailId = envelope?.messageId || `imap-${Date.now()}-${processed}`;
              if (this.seenIds.has(emailId)) {
                processed++;
                return;
              }

              const subject = envelope?.subject || '(no subject)';
              const fromAddr = envelope?.from?.[0]
                ? `${envelope.from[0].mailbox}@${envelope.from[0].host}`
                : 'unknown@unknown';
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- imap address untyped
              const toAddrs = (envelope?.to || []).map((t: any) => `${t.mailbox}@${t.host}`);
              const date = envelope?.date ? new Date(envelope.date) : new Date();
              const threadId = this.deriveThreadId(subject, fromAddr);

              const emailMessage: EmailMessage = {
                id: emailId,
                from: fromAddr,
                to: toAddrs,
                subject,
                body: this.extractTextBody(buffer),
                threadId,
                date,
              };

              messages.push(emailMessage);
              processed++;
            });
          });

          f.once('error', (fetchErr: Error) => {
            reject(fetchErr);
          });

          f.once('end', () => {
            imap.closeBox((closeErr: Error | null) => {
              if (closeErr) {
                // Best-effort close — log but don't fail
                this.log.warn('[Channel:Email] Failed to close IMAP box', { error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
              }
              resolve(messages);
            });
          });
        });
      });
    });
  }

  private deriveThreadId(subject: string, fromAddr: string): string {
    // Strip Re:/Fwd: prefixes and normalize
    const normalized = subject
      .replace(/^(re|fwd|fw):\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // Simple hash for thread ID
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
      hash |= 0;
    }
    return `thread-${Math.abs(hash).toString(36)}`;
  }

  private addToThread(msg: EmailMessage): void {
    let thread = this.threads.get(msg.threadId);
    if (!thread) {
      thread = {
        id: msg.threadId,
        subject: msg.subject,
        messages: [],
      };
      this.threads.set(msg.threadId, thread);
    }
    thread.messages.push(msg);
    thread.messages.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  private extractTextBody(raw: string): string {
    // Simple text extraction — strip MIME headers and get text/plain part
    const textPartMatch = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=--|\r?\n\.\r?\n|$)/i);
    if (textPartMatch) {
      return textPartMatch[1]
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .trim();
    }
    // Fallback: strip HTML tags
    const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=--|\r?\n\.\r?\n|$)/i);
    if (htmlMatch) {
      return htmlMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
    }
    // Last resort: return raw minus headers
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart > 0) {
      return raw.slice(bodyStart + 4).trim();
    }
    return raw;
  }
}
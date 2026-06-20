/**
 * Lodestone Tool — Send Message
 *
 * Send messages to external channels: Slack, Discord, Telegram, Email, Webhook.
 * Reads API tokens from environment variables.
 * Uses nodemailer for email (lazy import).
 */

import { readFileSync } from 'fs';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export class SendMessageTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'send-message',
    name: 'Send Message',
    description: 'Send messages to external channels: Slack, Discord, Telegram, Email, or Webhook.',
    parameters: [
      { name: 'channel', type: 'string', description: 'Channel: slack, discord, telegram, email, webhook', required: true, enum: ['slack', 'discord', 'telegram', 'email', 'webhook'] },
      { name: 'to', type: 'string', description: 'Recipient: channel ID, user ID, email address, or webhook URL', required: true },
      { name: 'message', type: 'string', description: 'Message content', required: true },
      { name: 'subject', type: 'string', description: 'Subject line (for email)', required: false },
      { name: 'attachments', type: 'array', description: 'File paths to attach', required: false, items: { name: 'path', type: 'string', description: 'File path', required: true } },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 15000,
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const channel = params.channel as string;
    const to = params.to as string;
    const message = params.message as string;
    const start = Date.now();

    if (!to) return this.missingParam('to', start);
    if (!message) return this.missingParam('message', start);

    try {
      switch (channel) {
        case 'webhook':
          return await this.sendWebhook(to, message, params, start);
        case 'slack':
          return await this.sendSlack(to, message, start);
        case 'discord':
          return await this.sendDiscord(to, message, start);
        case 'telegram':
          return await this.sendTelegram(to, message, start);
        case 'email':
          return await this.sendEmail(to, message, params, start);
        default:
          return {
            success: false, data: null,
            summary: `Unknown channel: ${channel}`,
            error: `Unknown channel: ${channel}`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Send to ${channel} failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
  }

  // ─── Webhook ──────────────────────────────────────────────

  private async sendWebhook(url: string, message: string, params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const payload = {
      text: message,
      subject: params.subject || undefined,
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);

    return {
      success: true,
      data: { delivered: true, messageId: `webhook-${Date.now()}`, status: res.status },
      summary: `Sent webhook to ${url}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Slack ────────────────────────────────────────────────

  private async sendSlack(channel: string, message: string, start: number): Promise<ToolResult> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is not set');
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text: message }),
    });

    const data = await res.json() as { ok: boolean; error?: string; ts?: string };
    if (!data.ok) throw new Error(`Slack API error: ${data.error || 'unknown'}`);

    return {
      success: true,
      data: { delivered: true, messageId: data.ts },
      summary: `Sent Slack message to ${channel}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Discord ──────────────────────────────────────────────

  private async sendDiscord(channelId: string, message: string, start: number): Promise<ToolResult> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
    }

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Discord API error (${res.status}): ${errText}`);
    }

    const data = await res.json() as { id: string };

    return {
      success: true,
      data: { delivered: true, messageId: data.id },
      summary: `Sent Discord message to ${channelId}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Telegram ─────────────────────────────────────────────

  private async sendTelegram(chatId: string, message: string, start: number): Promise<ToolResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });

    const data = await res.json() as { ok: boolean; description?: string; result?: { message_id: number } };
    if (!data.ok) throw new Error(`Telegram API error: ${data.description || 'unknown'}`);

    return {
      success: true,
      data: { delivered: true, messageId: String(data.result?.message_id ?? Date.now()) },
      summary: `Sent Telegram message to ${chatId}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Email ────────────────────────────────────────────────

  private async sendEmail(to: string, message: string, params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const subject = (params.subject as string) || 'Lodestone Message';
    const attachments = (params.attachments as string[]) || [];

    // Lazy import nodemailer
    let nodemailer: { createTransport(config: Record<string, unknown>): { sendMail(opts: Record<string, unknown>): Promise<{ messageId: string }> } };
    try {
      // @ts-ignore — nodemailer may not be installed
      nodemailer = await import('nodemailer');
    } catch {
      throw new Error('nodemailer is not installed. Install it with: npm install nodemailer');
    }

    const transportConfig: Record<string, unknown> = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    };

    const transporter = nodemailer.createTransport(transportConfig);

    const mailOptions: Record<string, unknown> = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'lodestone@localhost',
      to,
      subject,
      text: message,
    };

    // Attach files if provided
    if (attachments.length > 0) {
      mailOptions.attachments = attachments.map((path) => {
        try {
          const content = readFileSync(path);
          return { path, content };
        } catch {
          return { path };
        }
      });
    }

    const info = await transporter.sendMail(mailOptions);

    return {
      success: true,
      data: { delivered: true, messageId: info.messageId },
      summary: `Sent email to ${to} (subject: ${subject})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private missingParam(name: string, start: number): ToolResult {
    return {
      success: false, data: null,
      summary: `Missing required parameter: ${name}`,
      error: `Missing parameter: ${name}`,
      durationMs: Date.now() - start, includeInContext: false,
    };
  }
}
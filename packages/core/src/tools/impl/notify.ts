/**
 * Lodestone Tool — Notify
 *
 * Send system notifications (desktop push, mobile push).
 * Desktop: osascript (macOS) or notify-send (Linux).
 * Mobile: Pushover or Telegram bot API.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type Priority = 'low' | 'normal' | 'high' | 'urgent';
type NotifyAction = 'desktop' | 'mobile' | 'both';

export class NotifyTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'notify',
    name: 'System Notification',
    description: 'Send desktop and/or mobile push notifications. Uses osascript (macOS), notify-send (Linux), and Pushover or Telegram for mobile.',
    parameters: [
      { name: 'title', type: 'string', description: 'Notification title', required: true },
      { name: 'body', type: 'string', description: 'Notification body text', required: true },
      { name: 'priority', type: 'string', description: 'Priority level: low, normal, high, or urgent', required: false, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
      { name: 'action', type: 'string', description: 'Where to send: desktop, mobile, or both', required: false, enum: ['desktop', 'mobile', 'both'], default: 'desktop' },
      { name: 'url', type: 'string', description: 'URL to open when notification is clicked', required: false },
    ],
    sideEffects: true,
    requiresApproval: false,
    timeout: 10000,
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const title = params.title as string;
    const body = params.body as string;
    const priority = (params.priority as Priority) || 'normal';
    const action = (params.action as NotifyAction) || 'desktop';
    const url = params.url as string | undefined;
    const start = Date.now();

    if (!title) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: title',
        error: 'title is required',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
    if (!body) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: body',
        error: 'body is required',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const channels: string[] = [];
    const errors: string[] = [];

    try {
      // Desktop notification
      if (action === 'desktop' || action === 'both') {
        try {
          await this.sendDesktop(title, body, priority, url);
          channels.push('desktop');
        } catch (err) {
          errors.push(`desktop: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Mobile notification
      if (action === 'mobile' || action === 'both') {
        try {
          await this.sendMobile(title, body, priority, url);
          channels.push('mobile');
        } catch (err) {
          errors.push(`mobile: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // If nothing succeeded
      if (channels.length === 0 && errors.length > 0) {
        return {
          success: false,
          data: null,
          summary: `Notification delivery failed: ${errors.join('; ')}`,
          error: errors.join('; '),
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }

      return {
        success: true,
        data: {
          delivered: true,
          channels,
          errors: errors.length > 0 ? errors : undefined,
        },
        summary: `Sent "${title}" to ${channels.join(', ')}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Notification failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Desktop ────────────────────────────────────────────────────────────────

  private async sendDesktop(title: string, body: string, priority: Priority, url?: string): Promise<void> {
    const platform = process.platform;
    const escapedTitle = this.escapeAppleScript(title);
    const escapedBody = this.escapeAppleScript(body);

    if (platform === 'darwin') {
      // macOS: use osascript display notification
      let script = `display notification "${escapedBody}" with title "${escapedTitle}"`;

      // Add sound based on priority
      if (priority === 'high' || priority === 'urgent') {
        script += ' sound name "Glass"';
      }

      await execFileAsync('osascript', ['-e', script], { timeout: 8000 });

      // If URL provided and priority is urgent, also open the URL
      if (url && priority === 'urgent') {
        await execFileAsync('open', [url], { timeout: 5000 });
      }
    } else {
      // Linux: use notify-send
      const urgencyMap: Record<Priority, string> = {
        low: 'low',
        normal: 'normal',
        high: 'critical',
        urgent: 'critical',
      };

      const args = [
        '-u', urgencyMap[priority],
        '-a', 'Lodestone',
      ];

      if (url) {
        args.push('-h', `string:desktop:lodestone:${url}`);
      }

      args.push(title, body);

      try {
        await execFileAsync('notify-send', args, { timeout: 8000 });
      } catch {
        throw new Error('notify-send not available. Install: apt install libnotify-bin');
      }
    }
  }

  // ─── Mobile ─────────────────────────────────────────────────────────────────

  private async sendMobile(title: string, body: string, priority: Priority, url?: string): Promise<void> {
    // Try Pushover first, then Telegram
    const pushoverToken = process.env.PUSHOVER_TOKEN;
    const pushoverUser = process.env.PUSHOVER_USER;

    if (pushoverToken && pushoverUser) {
      await this.sendViaPushover(pushoverToken, pushoverUser, title, body, priority, url);
      return;
    }

    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (telegramToken && telegramChatId) {
      await this.sendViaTelegram(telegramToken, telegramChatId, title, body, url);
      return;
    }

    throw new Error(
      'No mobile notification provider configured. Set either:\n' +
      '1. PUSHOVER_TOKEN and PUSHOVER_USER for Pushover\n' +
      '2. TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for Telegram'
    );
  }

  private async sendViaPushover(
    token: string, user: string, title: string, body: string, priority: Priority, url?: string
  ): Promise<void> {
    const priorityMap: Record<Priority, number> = {
      low: -1,
      normal: 0,
      high: 1,
      urgent: 2,
    };

    const formData = new FormData();
    formData.append('token', token);
    formData.append('user', user);
    formData.append('title', title.slice(0, 100));
    formData.append('message', body.slice(0, 1024));
    formData.append('priority', String(priorityMap[priority]));

    if (url) {
      formData.append('url', url);
    }

    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pushover API error ${res.status}: ${text}`);
    }
  }

  private async sendViaTelegram(
    token: string, chatId: string, title: string, body: string, url?: string
  ): Promise<void> {
    const text = `*${this.escapeMarkdown(title)}*\n\n${this.escapeMarkdown(body)}${url ? `\n\n${url}` : ''}`;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false,
      }),
    });

    if (!res.ok) {
      const data = await res.text();
      throw new Error(`Telegram API error ${res.status}: ${data}`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private escapeAppleScript(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }
}
/**
 * Lodestone Core — Telegram Channel
 *
 * Uses grammy for Telegram Bot API interaction.
 * Polling mode — no webhook server needed for MVP.
 * Supports streaming responses (edit messages as text arrives).
 */

import { Channel, type ChannelConfig, type ChannelMessage } from './channel.js';
import { getLogger } from '../utils/logger.js';

// ─── Telegram Config ──────────────────────────────────────────────────────

export interface TelegramConfig extends ChannelConfig {
  type: 'telegram';
  /** Bot token from @BotFather */
  botToken: string;
  /** Polling interval in ms (default: 1000) */
  pollingInterval?: number;
  /** Maximum message length before splitting (Telegram limit: 4096) */
  maxMessageLength?: number;
  /** Enable streaming responses (edit messages as text arrives) */
  streaming?: boolean;
  /** Streaming edit interval in ms (default: 500) */
  streamingInterval?: number;
}

// ─── Telegram Channel ─────────────────────────────────────────────────────

export class TelegramChannel extends Channel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy Bot loaded dynamically
  private bot: any = null; // grammy Bot instance (loaded dynamically)
  private sessionMap: Map<string, string> = new Map(); // chatId → sessionId
  private streamingMessages: Map<string, number> = new Map(); // sessionId → last sent messageId
  private streamingBuffers: Map<string, string> = new Map(); // sessionId → accumulated text
  private streamingTimers: Map<string, ReturnType<typeof setInterval>> = new Map(); // sessionId → interval

  private readonly maxMessageLength: number;
  private readonly streamingEnabled: boolean;
  private readonly streamingInterval: number;
  private logger = getLogger('Channel:Telegram');

  constructor(config: TelegramConfig) {
    super(config);
    this.maxMessageLength = config.maxMessageLength || 4096;
    this.streamingEnabled = config.streaming ?? true;
    this.streamingInterval = config.streamingInterval || 500;
  }

  get id(): string {
    return `telegram:${this.config.botToken?.toString().slice(-6) || 'unknown'}`;
  }

  get name(): string {
    return 'Telegram';
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Dynamically import grammy — it's an optional peer dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy exports not typed at runtime
    let Bot: any;
    try {
      // @ts-ignore — optional peer dependency
      const grammy = await import('grammy');
      Bot = grammy.Bot;
    } catch {
      this.logger.error('grammy package not installed. Install with: npm install grammy');
      throw new Error('grammy package is required for the Telegram channel. Install with: npm install grammy');
    }

    this.bot = new Bot(this.config.botToken as string);

    // /start command
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.command('start', async (ctx: any) => {
      await ctx.reply(
        '🔮 Welcome to Lodestone!\n\n' +
        'I\'m your agent. Send me a message and I\'ll think, act, and respond.\n\n' +
        'Commands:\n' +
        '/help — Show available commands\n' +
        '/reset — Start a fresh session'
      );
    });

    // /help command
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.command('help', async (ctx: any) => {
      await ctx.reply(
        '🔮 Lodestone Commands\n\n' +
        '/start — Welcome message\n' +
        '/help — This message\n' +
        '/reset — Reset your session (clear context)\n\n' +
        'Otherwise, just send a message and I\'ll respond.'
      );
    });

    // /reset command
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.command('reset', async (ctx: any) => {
      const chatId = ctx.chat.id.toString();
      this.sessionMap.delete(chatId);
      this.streamingMessages.delete(chatId);
      this.streamingBuffers.delete(chatId);
      if (this.streamingTimers.has(chatId)) {
        clearInterval(this.streamingTimers.get(chatId)!);
        this.streamingTimers.delete(chatId);
      }
      await ctx.reply('🔄 Session reset. Fresh context — fire away.');
    });

    // Handle all text messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.on('message:text', async (ctx: any) => {
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;

      // Skip commands (handled above)
      if (text.startsWith('/')) return;

      // Create or find session
      let sessionId = this.sessionMap.get(chatId);
      if (!sessionId) {
        // The ChannelManager will handle session creation via the message handler
        sessionId = `telegram-${chatId}`;
        this.sessionMap.set(chatId, sessionId);
      }

      const message: ChannelMessage = {
        sessionId,
        content: text,
        senderId: ctx.from.id.toString(),
        senderName: ctx.from.first_name || ctx.from.username || 'Unknown',
        channelId: this.id,
        timestamp: new Date().toISOString(),
        metadata: {
          chatId,
          messageId: ctx.message.message_id,
          username: ctx.from.username,
        },
      };

      await this.emitMessage(message);
    });

    // Start polling
    await this.bot.start({
      allowed_updates: ['message'],
    });

    this.running = true;
    this.logger.info('Started polling', { id: this.id });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // Stop all streaming timers
    for (const timer of this.streamingTimers.values()) {
      clearInterval(timer);
    }
    this.streamingTimers.clear();

    // Stop the bot
    if (this.bot) {
      this.bot.stop();
    }

    this.running = false;
    this.logger.info('Stopped', { id: this.id });
  }

  async send(sessionId: string, message: string): Promise<void> {
    if (!this.bot) {
      this.logger.error('Bot not initialized — cannot send');
      return;
    }

    const chatId = this.getChatId(sessionId);
    if (!chatId) {
      this.logger.error('No chat ID for session', { sessionId });
      return;
    }

    // Split message if it exceeds Telegram's limit
    const chunks = this.splitMessage(message);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      } catch (err) {
        // Fallback: send without HTML parsing
        try {
          await this.bot.api.sendMessage(chatId, chunk);
        } catch (fallbackErr) {
          this.logger.error('Failed to send message', { error: fallbackErr });
        }
      }
    }
  }

  /**
   * Start streaming a response — creates a placeholder message that gets edited.
   * Call `streamDelta` to append text, then `streamEnd` to finalize.
   */
  async streamStart(sessionId: string): Promise<void> {
    if (!this.streamingEnabled || !this.bot) return;

    const chatId = this.getChatId(sessionId);
    if (!chatId) return;

    // Send initial "thinking" message
    try {
      const msg = await this.bot.api.sendMessage(chatId, '🔮 _thinking..._', { parse_mode: 'Markdown' });
      this.streamingMessages.set(sessionId, msg.message_id);
      this.streamingBuffers.set(sessionId, '');
    } catch {
      // Non-critical — streaming will degrade gracefully
    }
  }

  /**
   * Append text to the streaming response.
   * Edits the placeholder message at the configured interval.
   */
  streamDelta(sessionId: string, text: string): void {
    if (!this.streamingEnabled || !this.bot) return;

    const existing = this.streamingBuffers.get(sessionId) || '';
    this.streamingBuffers.set(sessionId, existing + text);

    // Throttle edits — start a timer if one isn't running
    if (!this.streamingTimers.has(sessionId)) {
      const timer = setInterval(() => this.flushStream(sessionId), this.streamingInterval);
      this.streamingTimers.set(sessionId, timer);
    }
  }

  /**
   * Finalize a streaming response.
   * Sends the remaining buffer and cleans up the streaming state.
   */
  async streamEnd(sessionId: string): Promise<void> {
    if (!this.streamingEnabled || !this.bot) return;

    // Stop the streaming timer
    const timer = this.streamingTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.streamingTimers.delete(sessionId);
    }

    // Flush remaining buffer
    await this.flushStream(sessionId);
    this.streamingMessages.delete(sessionId);
    this.streamingBuffers.delete(sessionId);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  private async flushStream(sessionId: string): Promise<void> {
    const messageId = this.streamingMessages.get(sessionId);
    const buffer = this.streamingBuffers.get(sessionId);
    const chatId = this.getChatId(sessionId);

    if (!messageId || !buffer || !chatId) return;

    // Truncate for Telegram edit limit
    const text = buffer.length > this.maxMessageLength
      ? buffer.slice(0, this.maxMessageLength - 3) + '...'
      : buffer;

    try {
      await this.bot.api.editMessageText(chatId, messageId, text);
    } catch {
      // Message may not have changed — ignore
    }
  }

  private getChatId(sessionId: string): string | null {
    // Reverse-lookup: find chatId by sessionId
    for (const [chatId, sid] of this.sessionMap.entries()) {
      if (sid === sessionId) return chatId;
    }
    // Fallback: extract from sessionId format "telegram-<chatId>"
    if (sessionId.startsWith('telegram-')) {
      return sessionId.replace('telegram-', '');
    }
    return null;
  }

  private splitMessage(text: string): string[] {
    if (text.length <= this.maxMessageLength) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = this.maxMessageLength;
      // Try to split at a newline or space near the limit
      const lastNewline = remaining.lastIndexOf('\n', this.maxMessageLength);
      const lastSpace = remaining.lastIndexOf(' ', this.maxMessageLength);
      if (lastNewline > this.maxMessageLength * 0.5) {
        splitAt = lastNewline + 1;
      } else if (lastSpace > this.maxMessageLength * 0.5) {
        splitAt = lastSpace + 1;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
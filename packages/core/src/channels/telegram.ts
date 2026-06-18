/**
 * Lodestone Core — Telegram Channel
 *
 * Uses grammy for Telegram Bot API interaction.
 * Polling mode — no webhook server needed for MVP.
 * Supports streaming responses (edit messages as text arrives).
 *
 * Retry, rate limiting, and message splitting are handled by the Channel base class.
 * This implementation only provides sendRaw() and getMaxMessageLength().
 */

import { Channel, type ChannelConfig, type ChannelMessage, type ChannelHealth } from './channel.js';
import { getLogger } from '../utils/logger.js';

// ─── Telegram Config ──────────────────────────────────────────────────────

export interface TelegramConfig extends ChannelConfig {
  type: 'telegram';
  /** Bot token from @BotFather */
  botToken: string;
  /** Polling interval in ms (default: 1000) */
  pollingInterval?: number;
  /** Enable streaming responses (edit messages as text arrives) */
  streaming?: boolean;
  /** Streaming edit interval in ms (default: 500) */
  streamingInterval?: number;
  /** Min delay between sends to same chat in ms (default: 1000 = 1 msg/sec) */
  perChatRateLimitMs?: number;
}

// ─── Telegram Channel ─────────────────────────────────────────────────────

export class TelegramChannel extends Channel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy Bot loaded dynamically
  private bot: any = null; // grammy Bot instance (loaded dynamically)
  private sessionMap: Map<string, string> = new Map(); // chatId → sessionId
  private streamingMessages: Map<string, number> = new Map(); // sessionId → last sent messageId
  private streamingBuffers: Map<string, string> = new Map(); // sessionId → accumulated text
  private streamingTimers: Map<string, ReturnType<typeof setInterval>> = new Map(); // sessionId → interval

  private readonly streamingEnabled: boolean;
  private readonly streamingInterval: number;
  private readonly perChatRateLimitMs: number;
  private lastSendTime: Map<string, number> = new Map(); // chatId → last send timestamp
  private logger = getLogger('Channel:Telegram');

  constructor(config: TelegramConfig) {
    super(config);
    this.streamingEnabled = config.streaming ?? true;
    this.streamingInterval = config.streamingInterval || 500;
    this.perChatRateLimitMs = config.perChatRateLimitMs ?? 1000;
    // Set base class rate limit: Telegram allows ~30 msgs/sec
    this.setRateLimit(30);
  }

  get id(): string {
    return `telegram:${this.config.botToken?.toString().slice(-6) || 'unknown'}`;
  }

  get name(): string {
    return 'Telegram';
  }

  getMaxMessageLength(): number {
    return 4096;
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

    // Handle media messages (photos, documents, voice, stickers, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.on('message:photo', async (ctx: any) => {
      const chatId = ctx.chat.id.toString();
      let sessionId = this.sessionMap.get(chatId);
      if (!sessionId) {
        sessionId = `telegram-${chatId}`;
        this.sessionMap.set(chatId, sessionId);
      }

      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const caption = ctx.message.caption || '(no caption)';

      const message: ChannelMessage = {
        sessionId,
        content: `[Photo: ${caption}]`,
        senderId: ctx.from.id.toString(),
        senderName: ctx.from.first_name || ctx.from.username || 'Unknown',
        channelId: this.id,
        timestamp: new Date().toISOString(),
        metadata: {
          chatId,
          messageId: ctx.message.message_id,
          username: ctx.from.username,
          mediaType: 'photo',
          fileId: largest?.file_id,
          fileSize: largest?.file_size,
          caption,
        },
      };

      await this.emitMessage(message);
    });

    // Handle documents
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.on('message:document', async (ctx: any) => {
      const chatId = ctx.chat.id.toString();
      let sessionId = this.sessionMap.get(chatId);
      if (!sessionId) {
        sessionId = `telegram-${chatId}`;
        this.sessionMap.set(chatId, sessionId);
      }

      const doc = ctx.message.document;
      const caption = ctx.message.caption || doc.file_name || 'document';

      const message: ChannelMessage = {
        sessionId,
        content: `[Document: ${caption} (${doc.file_name || 'unknown'}, ${doc.file_size || 0} bytes)]`,
        senderId: ctx.from.id.toString(),
        senderName: ctx.from.first_name || ctx.from.username || 'Unknown',
        channelId: this.id,
        timestamp: new Date().toISOString(),
        metadata: {
          chatId,
          messageId: ctx.message.message_id,
          username: ctx.from.username,
          mediaType: 'document',
          fileId: doc.file_id,
          fileName: doc.file_name,
          fileSize: doc.file_size,
          mimeType: doc.mime_type,
          caption,
        },
      };

      await this.emitMessage(message);
    });

    // Handle voice messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grammy ctx type
    this.bot.on('message:voice', async (ctx: any) => {
      const chatId = ctx.chat.id.toString();
      let sessionId = this.sessionMap.get(chatId);
      if (!sessionId) {
        sessionId = `telegram-${chatId}`;
        this.sessionMap.set(chatId, sessionId);
      }

      const voice = ctx.message.voice;

      const message: ChannelMessage = {
        sessionId,
        content: `[Voice message: ${voice.duration}s]`,
        senderId: ctx.from.id.toString(),
        senderName: ctx.from.first_name || ctx.from.username || 'Unknown',
        channelId: this.id,
        timestamp: new Date().toISOString(),
        metadata: {
          chatId,
          messageId: ctx.message.message_id,
          username: ctx.from.username,
          mediaType: 'voice',
          fileId: voice.file_id,
          duration: voice.duration,
        },
      };

      await this.emitMessage(message);
    });

    // Start polling
    await this.bot.start({
      allowed_updates: ['message'],
    });

    this.onStart();
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

    this.onStop();
    this.logger.info('Stopped', { id: this.id });
  }

  /** Send a raw message — base class handles retry, rate limiting, and splitting */
  protected async sendRaw(sessionId: string, message: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Bot not initialized — cannot send');
    }

    const chatId = this.getChatId(sessionId);
    if (!chatId) {
      throw new Error(`No chat ID for session: ${sessionId}`);
    }

    // Per-chat rate limit (additional to base class rate limiting)
    await this.enforceRateLimit(chatId);

    // Try with HTML first, fall back to plain text
    try {
      await this.bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (err: any) {
      if (err?.message?.includes('parse')) {
        // Parse error — retry without HTML
        await this.bot.api.sendMessage(chatId, message);
      } else if (err?.error_code === 429 && err?.parameters?.retry_after) {
        // Telegram rate limit — respect retry_after
        const delayMs = (err.parameters.retry_after + 1) * 1000;
        this.logger.warn('Rate limited by Telegram, waiting', { delayMs, chatId });
        await new Promise(r => setTimeout(r, delayMs));
        await this.bot.api.sendMessage(chatId, message);
      } else {
        throw err; // Let base class handle retry
      }
    }
  }

  /** Enforce per-chat rate limit */
  private async enforceRateLimit(chatId: string): Promise<void> {
    const last = this.lastSendTime.get(chatId) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < this.perChatRateLimitMs) {
      await new Promise(r => setTimeout(r, this.perChatRateLimitMs - elapsed));
    }
    this.lastSendTime.set(chatId, Date.now());
  }

  /**
   * Start streaming a response — creates a placeholder message that gets edited.
   * Call `streamDelta` to append text, then `streamEnd` to finalize.
   */
  async streamStart(sessionId: string): Promise<void> {
    if (!this.streamingEnabled || !this.bot) return;

    const chatId = this.getChatId(sessionId);
    if (!chatId) return;

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

    const timer = this.streamingTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.streamingTimers.delete(sessionId);
    }

    await this.flushStream(sessionId);
    this.streamingMessages.delete(sessionId);
    this.streamingBuffers.delete(sessionId);
  }

  /** Get detailed channel health status */
  getHealth(): ChannelHealth {
    const base = super.getHealth();
    let status: ChannelHealth['status'] = base.status;
    if (this.running && !this.bot) {
      status = 'degraded';
    }
    return {
      ...base,
      status,
      details: {
        botInitialized: this.bot !== null,
        activeStreams: this.streamingTimers.size,
        trackedSessions: this.sessionMap.size,
      },
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private async flushStream(sessionId: string): Promise<void> {
    const messageId = this.streamingMessages.get(sessionId);
    const buffer = this.streamingBuffers.get(sessionId);
    const chatId = this.getChatId(sessionId);

    if (!messageId || !buffer || !chatId) return;

    const maxLen = this.getMaxMessageLength();
    const text = buffer.length > maxLen
      ? buffer.slice(0, maxLen - 3) + '...'
      : buffer;

    try {
      await this.bot.api.editMessageText(chatId, messageId, text);
    } catch (err: any) {
      if (err?.description?.includes('not modified')) return;
      if (!err?.description?.includes('chat not found')) {
        try {
          await this.bot.api.editMessageText(chatId, messageId, text);
        } catch {
          // Second failure — give up on this edit
        }
      }
    }
  }

  private getChatId(sessionId: string): string | null {
    for (const [chatId, sid] of this.sessionMap.entries()) {
      if (sid === sessionId) return chatId;
    }
    if (sessionId.startsWith('telegram-')) {
      return sessionId.replace('telegram-', '');
    }
    return null;
  }
}
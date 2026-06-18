/**
 * Lodestone Core — Discord Channel
 *
 * Uses discord.js for Discord Bot API interaction.
 * Listens to messages in configured channels, routes to agent loop,
 * and sends responses back.
 */

import { Channel, type ChannelConfig, type ChannelMessage } from './channel.js';
import { getLogger } from '../utils/logger.js';

// ─── Discord Config ──────────────────────────────────────────────────────

export interface DiscordConfig extends ChannelConfig {
  type: 'discord';
  /** Discord bot token */
  botToken: string;
  /** Channel ID(s) to listen on (can be a single ID or array) */
  channelId: string | string[];
  /** Guild ID (optional — restricts to one server) */
  guildId?: string;
  /** Maximum message length (Discord limit: 2000) */
  maxMessageLength?: number;
  /** Enable streaming responses (edit messages as text arrives) */
  streaming?: boolean;
}

// ─── Discord Channel ─────────────────────────────────────────────────────

export class DiscordChannel extends Channel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discord.js Client loaded dynamically
  private client: any = null; // discord.js Client instance (loaded dynamically)
  private sessionMap: Map<string, string> = new Map(); // userId → sessionId
  private streamingMessages: Map<string, string> = new Map(); // sessionId → last sent message ID

  private readonly channelIds: Set<string>;
  private readonly maxMessageLength: number;
  private readonly streamingEnabled: boolean;
  private logger = getLogger('Channel:Discord');

  constructor(config: DiscordConfig) {
    super(config);

    // Normalize channel IDs to a Set
    const ids = Array.isArray(config.channelId) ? config.channelId : [config.channelId];
    this.channelIds = new Set(ids);

    this.maxMessageLength = config.maxMessageLength || 2000;
    this.streamingEnabled = config.streaming ?? true;
  }

  get id(): string {
    return `discord:${Array.from(this.channelIds).join(',')}`;
  }

  get name(): string {
    return 'Discord';
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Dynamically import discord.js — it's an optional peer dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discord.js loaded dynamically
    let Client: any, GatewayIntentBits: any, REST: any, Routes: any, SlashCommandBuilder: any;
    try {
      // @ts-ignore — optional peer dependency
      const discordJs = await import('discord.js');
      Client = discordJs.Client;
      GatewayIntentBits = discordJs.GatewayIntentBits;
      REST = discordJs.REST;
      Routes = discordJs.Routes;
      SlashCommandBuilder = discordJs.SlashCommandBuilder;
    } catch {
      this.logger.error('discord.js package not installed. Install with: npm install discord.js');
      throw new Error('discord.js package is required for the Discord channel. Install with: npm install discord.js');
    }

    // Create client with necessary intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Register slash commands
    const commands = [
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show available commands'),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset your session (clear context)'),
    ].map(cmd => cmd.toJSON());

    // Register commands on ready
    this.client.once('ready', async () => {
      this.logger.info('Bot ready', { tag: this.client.user.tag });

      try {
        const rest = new REST({ version: '10' }).setToken(this.config.botToken as string);
        const guildId = this.config.guildId as string | undefined;
        if (guildId) {
          await rest.put(Routes.applicationGuildCommands(this.client.user.id, guildId), { body: commands });
        } else {
          await rest.put(Routes.applicationCommands(this.client.user.id), { body: commands });
        }
        this.logger.info('Slash commands registered');
      } catch (err) {
        this.logger.error('Failed to register commands', { error: err });
      }
    });

    // Handle slash commands
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discord.js interaction type
    this.client.on('interactionCreate', async (interaction: any) => {
      if (!interaction.isChatInputCommand()) return;

      switch (interaction.commandName) {
        case 'help': {
          await interaction.reply({
            content:
              '🔮 **Lodestone Commands**\n\n' +
              '`/help` — Show this message\n' +
              '`/reset` — Reset your session\n\n' +
              'Or just send a message in a configured channel.',
            ephemeral: true,
          });
          break;
        }
        case 'reset': {
          const userId = interaction.user.id;
          this.sessionMap.delete(userId);
          this.streamingMessages.delete(userId);
          await interaction.reply({
            content: '🔄 Session reset. Fresh context — fire away.',
            ephemeral: true,
          });
          break;
        }
      }
    });

    // Handle messages in configured channels
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discord.js message type
    this.client.on('messageCreate', async (msg: any) => {
      // Ignore bot messages
      if (msg.author.bot) return;

      // Only respond in configured channels
      if (!this.channelIds.has(msg.channelId)) return;

      const text = msg.content;
      if (!text || text.startsWith('/')) return;

      const userId = msg.author.id;

      // Create or find session
      let sessionId = this.sessionMap.get(userId);
      if (!sessionId) {
        sessionId = `discord-${userId}`;
        this.sessionMap.set(userId, sessionId);
      }

      const message: ChannelMessage = {
        sessionId,
        content: text,
        senderId: userId,
        senderName: msg.author.username || 'Unknown',
        channelId: this.id,
        timestamp: new Date().toISOString(),
        metadata: {
          channelId: msg.channelId,
          messageId: msg.id,
          guildId: msg.guildId,
          username: msg.author.username,
          discriminator: msg.author.discriminator,
        },
      };

      // Show typing indicator while processing
      if (msg.channel) {
        await msg.channel.sendTyping().catch(() => {});
      }

      await this.emitMessage(message);
    });

    // Login
    await this.client.login(this.config.botToken as string);
    this.running = true;
    this.logger.info('Started', { id: this.id });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.client) {
      this.client.destroy();
    }

    this.running = false;
    this.logger.info('Stopped', { id: this.id });
  }

  async send(sessionId: string, message: string): Promise<void> {
    if (!this.client) {
      this.logger.error('Client not initialized — cannot send');
      return;
    }

    const channelInfo = this.getChannelInfo(sessionId);
    if (!channelInfo) {
      this.logger.error('No channel info for session', { sessionId });
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channelInfo.channelId);
      if (!channel || !channel.isTextBased()) {
        this.logger.error('Channel not found or not text-based', { channelId: channelInfo.channelId });
        return;
      }

      const chunks = this.splitMessage(message);
      for (const chunk of chunks) {
        const sent = await channel.send(chunk);
        this.streamingMessages.set(sessionId, sent.id);
      }
    } catch (err) {
      this.logger.error('Failed to send message', { error: err });
    }
  }

  /**
   * Start streaming a response — sends a placeholder message.
   */
  async streamStart(sessionId: string): Promise<void> {
    if (!this.streamingEnabled || !this.client) return;

    const channelInfo = this.getChannelInfo(sessionId);
    if (!channelInfo) return;

    try {
      const channel = await this.client.channels.fetch(channelInfo.channelId);
      if (!channel || !channel.isTextBased()) return;

      const msg = await channel.send('🔮 _thinking..._');
      this.streamingMessages.set(sessionId, msg.id);
    } catch {
      // Non-critical
    }
  }

  /**
   * Edit the streaming message with updated text.
   */
  async streamDelta(sessionId: string, text: string): Promise<void> {
    // Discord streaming is done via edits — throttle to avoid rate limits
    // The manager or caller should batch these calls
    if (!this.streamingEnabled || !this.client) return;

    const messageId = this.streamingMessages.get(sessionId);
    const channelInfo = this.getChannelInfo(sessionId);
    if (!messageId || !channelInfo) return;

    try {
      const channel = await this.client.channels.fetch(channelInfo.channelId);
      if (!channel || !channel.isTextBased()) return;

      const truncated = text.length > this.maxMessageLength
        ? text.slice(0, this.maxMessageLength - 3) + '...'
        : text;

      await channel.messages.edit(messageId, truncated);
    } catch {
      // Rate limit or message not found — ignore
    }
  }

  /**
   * Finalize a streaming response.
   */
  async streamEnd(sessionId: string, finalText: string): Promise<void> {
    if (!this.streamingEnabled || !this.client) return;

    await this.streamDelta(sessionId, finalText);
    this.streamingMessages.delete(sessionId);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  private getChannelInfo(sessionId: string): { channelId: string } | null {
    // Find the Discord channel for this session
    // Sessions are per-user, but we need to know which channel to send to
    // Walk through metadata stored in the session map
    for (const [userId, sid] of this.sessionMap.entries()) {
      if (sid === sessionId) {
        // Return the first configured channel (user's message came from here)
        return { channelId: Array.from(this.channelIds)[0] };
      }
    }
    return null;
  }

  private splitMessage(text: string): string[] {
    if (text.length <= this.maxMessageLength) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = this.maxMessageLength;
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
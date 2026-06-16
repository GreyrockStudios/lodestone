/**
 * Lodestone Core — Channel Manager
 *
 * Loads channel config, instantiates enabled channels,
 * routes incoming messages to the agent loop, and routes
 * responses back to the originating channel.
 *
 * Session tracking: each (channel, user) pair maps to one agent session.
 */

import { Channel, type ChannelConfig, type ChannelMessage } from './channel.js';
import { TelegramChannel, type TelegramConfig } from './telegram.js';
import { DiscordChannel, type DiscordConfig } from './discord.js';
import { WebChatChannel, type WebChatConfig } from './webchat.js';

// ─── Channel Manager Config ───────────────────────────────────────────────

export interface ChannelManagerConfig {
  /** Channel configurations */
  channels: ChannelConfig[];
}

// ─── Channel Manager ─────────────────────────────────────────────────────

export class ChannelManager {
  private channels: Map<string, Channel> = new Map();
  private messageHandler: ((message: ChannelMessage) => Promise<string | void>) | null = null;
  private running = false;

  constructor(config: ChannelManagerConfig) {
    // Instantiate enabled channels
    for (const chConfig of config.channels) {
      if (!chConfig.enabled) continue;

      try {
        const channel = this.createChannel(chConfig);
        this.channels.set(channel.id, channel);
        console.log(`[ChannelManager] Registered channel: ${channel.name} (${channel.id})`);
      } catch (err) {
        console.error(`[ChannelManager] Failed to create channel type '${chConfig.type}':`, err);
      }
    }
  }

  /**
   * Set the handler for incoming messages.
   * The handler receives a ChannelMessage and returns an optional response string.
   * If a response is returned, it's sent back to the originating channel.
   */
  onMessage(handler: (message: ChannelMessage) => Promise<string | void>): void {
    this.messageHandler = handler;
  }

  /**
   * Start all enabled channels.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Register the message handler on each channel
    for (const channel of this.channels.values()) {
      channel.onMessage(async (message: ChannelMessage) => {
        await this.handleIncomingMessage(message, channel);
      });
    }

    // Start all channels
    const startPromises: Promise<void>[] = [];
    for (const channel of this.channels.values()) {
      startPromises.push(
        channel.start().catch(err => {
          console.error(`[ChannelManager] Failed to start ${channel.name}:`, err);
        })
      );
    }

    await Promise.all(startPromises);
    this.running = true;
    console.log(`[ChannelManager] Started — ${this.channels.size} channel(s) active`);
  }

  /**
   * Stop all channels.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    const stopPromises: Promise<void>[] = [];
    for (const channel of this.channels.values()) {
      stopPromises.push(channel.stop());
    }

    await Promise.all(stopPromises);
    this.running = false;
    console.log('[ChannelManager] Stopped all channels');
  }

  /**
   * Send a message to a specific session on its channel.
   * Looks up which channel owns the session and routes accordingly.
   */
  async send(sessionId: string, message: string): Promise<void> {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) {
      console.error(`[ChannelManager] No channel found for session ${sessionId}`);
      return;
    }
    await channel.send(sessionId, message);
  }

  /**
   * Send a streaming delta to a specific session.
   * Only works for channels that support streaming (Telegram, WebChat).
   */
  streamDelta(sessionId: string, text: string): void {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) return;

    if ('streamDelta' in channel && typeof (channel as any).streamDelta === 'function') {
      (channel as any).streamDelta(sessionId, text);
    }
  }

  /**
   * Finalize a streaming response.
   */
  async streamEnd(sessionId: string, finalText: string): Promise<void> {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) return;

    if ('streamEnd' in channel && typeof (channel as any).streamEnd === 'function') {
      await (channel as any).streamEnd(sessionId, finalText);
    }
  }

  /**
   * Start a streaming response.
   */
  async streamStart(sessionId: string): Promise<void> {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) return;

    if ('streamStart' in channel && typeof (channel as any).streamStart === 'function') {
      await (channel as any).streamStart(sessionId);
    }
  }

  /**
   * Get a channel by its ID.
   */
  getChannel(channelId: string): Channel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * List all active channels.
   */
  listChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Check if the manager is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  private createChannel(config: ChannelConfig): Channel {
    switch (config.type) {
      case 'telegram':
        return new TelegramChannel(config as TelegramConfig);
      case 'discord':
        return new DiscordChannel(config as DiscordConfig);
      case 'webchat':
        return new WebChatChannel(config as WebChatConfig);
      default:
        throw new Error(`Unknown channel type: '${config.type}'. Supported: telegram, discord, webchat`);
    }
  }

  private async handleIncomingMessage(message: ChannelMessage, channel: Channel): Promise<void> {
    if (!this.messageHandler) {
      console.warn('[ChannelManager] No message handler registered — dropping message');
      return;
    }

    try {
      const response = await this.messageHandler(message);

      // If the handler returns a response string, send it back
      if (response && typeof response === 'string') {
        await channel.send(message.sessionId, response);
      }
    } catch (err) {
      console.error(`[ChannelManager] Error handling message from ${message.senderName}:`, err);
      // Try to send an error message back
      try {
        await channel.send(message.sessionId, '❌ An error occurred while processing your message. Please try again.');
      } catch {
        // Channel send also failed — nothing more we can do
      }
    }
  }

  private findChannelForSession(sessionId: string): Channel | undefined {
    // Session IDs are prefixed with the channel type: "telegram-...", "discord-...", "webchat-..."
    for (const channel of this.channels.values()) {
      const prefix = channel.id.split(':')[0];
      if (sessionId.startsWith(prefix)) {
        return channel;
      }
    }
    return undefined;
  }
}
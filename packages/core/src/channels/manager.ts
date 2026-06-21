/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Channel Manager
 *
 * Loads channel config, instantiates enabled channels,
 * routes incoming messages to the agent loop, and routes
 * responses back to the originating channel.
 *
 * Session tracking: each (channel, user) pair maps to one agent session.
 */

import { Channel, type ChannelConfig, type ChannelMessage, type ChannelHealth } from './channel.js';
import { getLogger } from '../utils/logger.js';
import { ChannelError } from '../utils/errors.js';
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
  private log = getLogger('channel-manager');
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
        this.log.info(`Registered channel: ${channel.name} (${channel.id})`);
      } catch (err) {
        this.log.error(`Failed to create channel type '${chConfig.type}'`, { error: err instanceof Error ? err.message : String(err) });
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
          this.log.error(`Failed to start ${channel.name}`, { error: err instanceof Error ? err.message : String(err) });
        })
      );
    }

    await Promise.all(startPromises);
    this.running = true;
    this.log.info(`Started — ${this.channels.size} channel(s) active`);
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
    this.log.info('Stopped all channels');
  }

  /**
   * Send a message to a specific session on its channel.
   * Looks up which channel owns the session and routes accordingly.
   */
  async send(sessionId: string, message: string): Promise<void> {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) {
      this.log.warn(`No channel found for session ${sessionId}`);
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

    const streamable = channel as Channel & { streamDelta?: (sessionId: string, text: string) => void };
    if (typeof streamable.streamDelta === 'function') {
      streamable.streamDelta(sessionId, text);
    }
  }

  /**
   * Finalize a streaming response.
   */
  async streamEnd(sessionId: string, finalText: string): Promise<void> {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) return;

    const streamable = channel as Channel & { streamEnd?: (sessionId: string, finalText: string) => Promise<void> };
    if (typeof streamable.streamEnd === 'function') {
      await streamable.streamEnd(sessionId, finalText);
    }
  }

  /**
   * Start a streaming response.
   */
  async streamStart(sessionId: string): Promise<void> {
    const channel = this.findChannelForSession(sessionId);
    if (!channel) return;

    const streamable = channel as Channel & { streamStart?: (sessionId: string) => Promise<void> };
    if (typeof streamable.streamStart === 'function') {
      await streamable.streamStart(sessionId);
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

  /** Get health status of all channels */
  getHealth(): Record<string, ChannelHealth> {
    const result: Record<string, ChannelHealth> = {};
    for (const channel of this.channels.values()) {
      result[channel.id] = channel.getHealth();
    }
    return result;
  }

  /** Check if any channels are down */
  hasDownChannels(): boolean {
    for (const channel of this.channels.values()) {
      if (!channel.isActive()) return true;
    }
    return false;
  }

  /** Check channel health and alert on degraded/down channels */
  checkHealth(): { healthy: number; degraded: number; down: number; alerts: string[] } {
    const alerts: string[] = [];
    let healthy = 0, degraded = 0, down = 0;

    for (const channel of this.channels.values()) {
      const health = channel.getHealth();
      if (health.status === 'healthy') {
        healthy++;
      } else if (health.status === 'degraded') {
        degraded++;
        alerts.push(`⚠️ ${channel.name} (${channel.id}) is degraded: ${JSON.stringify(health.details || {})}`);
      } else {
        down++;
        alerts.push(`🚨 ${channel.name} (${channel.id}) is down`);
      }
    }

    return { healthy, degraded, down, alerts };
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
        throw new ChannelError(`Unknown channel type: '${config.type}'. Supported: telegram, discord, webchat`, { context: { type: config.type } });
    }
  }

  private async handleIncomingMessage(message: ChannelMessage, channel: Channel): Promise<void> {
    if (!this.messageHandler) {
      this.log.warn('No message handler registered — dropping message');
      return;
    }

    try {
      const response = await this.messageHandler(message);

      // If the handler returns a response string, send it back
      if (response && typeof response === 'string') {
        await channel.send(message.sessionId, response);
      }
    } catch (err) {
      this.log.error(`Error handling message from ${message.senderName}`, { error: err instanceof Error ? err.message : String(err) });
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
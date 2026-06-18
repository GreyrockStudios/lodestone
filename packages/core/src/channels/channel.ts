/**
 * Lodestone Core — Channel Interface
 *
 * Abstract base class and types for all channel adapters.
 * Channels connect Lodestone to external messaging platforms
 * (Telegram, Discord, web chat, etc.).
 */

// ─── Channel Message ──────────────────────────────────────────────────────

export interface ChannelMessage {
  /** Unique session identifier (maps to an agent session) */
  sessionId: string;
  /** The text content of the message */
  content: string;
  /** User ID on the originating platform */
  senderId: string;
  /** Display name of the sender */
  senderName: string;
  /** Which channel this message came from */
  channelId: string;
  /** ISO timestamp */
  timestamp: string;
  /** Platform-specific metadata (reply-to IDs, attachments, etc.) */
  metadata: Record<string, unknown>;
}

// ─── Channel Config ───────────────────────────────────────────────────────

export interface ChannelConfig {
  /** Channel type identifier (e.g., 'telegram', 'discord', 'webchat') */
  type: string;
  /** Whether this channel should be started */
  enabled: boolean;
  /** Additional platform-specific config (spread into subclass) */
  [key: string]: unknown;
}

// ─── Message Handler ──────────────────────────────────────────────────────

export type MessageHandler = (message: ChannelMessage) => Promise<void>;

// ─── Channel Base Class ──────────────────────────────────────────────────

export interface ChannelHealth {
  status: 'healthy' | 'degraded' | 'down';
  active: boolean;
  details?: Record<string, unknown>;
}

import { getLogger } from '../utils/logger.js';

const logger = getLogger('Channel');

export abstract class Channel {
  readonly config: ChannelConfig;
  protected messageHandler: MessageHandler | null = null;
  protected running = false;

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  /** Unique identifier for this channel instance */
  abstract get id(): string;

  /** Human-readable name */
  abstract get name(): string;

  /** Start the channel — begin listening for messages */
  abstract start(): Promise<void>;

  /** Stop the channel — clean up resources */
  abstract stop(): Promise<void>;

  /** Send a message to a specific session on this channel */
  abstract send(sessionId: string, message: string): Promise<void>;

  /** Register a handler for incoming messages */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Is the channel currently running? */
  isActive(): boolean {
    return this.running;
  }

  /** Get channel health status */
  getHealth(): ChannelHealth {
    return {
      status: this.running ? 'healthy' : 'down',
      active: this.running,
    };
  }

  /** Emit an incoming message to the registered handler */
  protected async emitMessage(message: ChannelMessage): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(message);
    } else {
      logger.warn('No message handler registered — dropping message', { channelId: this.id, senderName: message.senderName });
    }
  }
}
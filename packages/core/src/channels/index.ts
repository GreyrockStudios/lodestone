/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Channel System
 *
 * Public API for the channel adapter system.
 * Import from '@lodestone/core' to use channels.
 */

// Base class and types
export { Channel, type ChannelConfig, type ChannelMessage, type MessageHandler } from './channel.js';

// Channel implementations
export { TelegramChannel, type TelegramConfig } from './telegram.js';
export { DiscordChannel, type DiscordConfig } from './discord.js';
export { WebChatChannel, type WebChatConfig } from './webchat.js';

// Manager
export { ChannelManager, type ChannelManagerConfig } from './manager.js';
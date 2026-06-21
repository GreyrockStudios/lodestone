/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — TUI Chat Message Types
 *
 * Defines the chat message interface and formatting functions.
 * Extracted from tui-chat.ts for cleaner separation.
 */

import { Theme, fg } from './theme.js';

const R = '\x1B[0m';
const B = '\x1B[1m';
const D = '\x1B[2m';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts: number;
  tokens?: number;
  ms?: number;
  tools?: string[];
  streaming?: boolean;
  toolName?: string;
  toolSuccess?: boolean;
  toolDuration?: number;
  toolSummary?: string;
}

/**
 * Format a Unix timestamp as a short HH:MM time string.
 * @param ts - Unix timestamp in milliseconds.
 * @returns Formatted time string (e.g. "02:30 PM").
 */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * @param ms - Duration in milliseconds.
 * @returns "450ms" for sub-second, "1.5s" for seconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build a formatted string for a user chat message.
 * @param msg - The chat message to format.
 * @param theme - The active theme (unused, reserved for future styling).
 * @returns ANSI-formatted string with sender label and timestamp.
 */
export function buildUserMessage(msg: ChatMessage, theme: Theme): string {
  const P = theme.colors;
  return `**you** ${D}${formatTimestamp(msg.ts)}${R}\n${msg.text}`;
}

/**
 * Build a formatted string for an assistant chat message with stats.
 * @param msg - The chat message to format.
 * @param theme - The active theme for coloring.
 * @param agentName - Display name for the agent (default: 'Lodestone').
 * @returns ANSI-formatted string with agent name, timestamp, text, and stats line.
 */
export function buildAssistantMessage(msg: ChatMessage, theme: Theme, agentName: string = 'Lodestone'): string {
  const P = theme.colors;
  const stats: string[] = [];
  if (msg.ms) stats.push(formatDuration(msg.ms));
  if (msg.tokens) stats.push(`${msg.tokens} tok`);
  if (msg.tools?.length) stats.push(`⚡${msg.tools.join(',')}`);
  const statsLine = stats.length > 0 ? `\n[${stats.join(' · ')}]` : '';
  return `**${theme.statusBar.icon} ${agentName}** ${D}${formatTimestamp(msg.ts)}${R}\n${msg.text}${statsLine}`;
}

/**
 * Build a formatted string for a tool execution result in chat.
 * @param msg - The chat message containing tool result data.
 * @param theme - The active theme for coloring.
 * @returns ANSI-formatted string with success/failure icon, tool name, duration, and summary.
 */
export function buildToolMessage(msg: ChatMessage, theme: Theme): string {
  const P = theme.colors;
  const icon = msg.toolSuccess ? `${fg(P.success)}✓${R}` : `${fg(P.error)}✗${R}`;
  const dur = msg.toolDuration ? ` ${D}${formatDuration(msg.toolDuration)}${R}` : '';
  return `${icon} ${fg(P.tool)}${msg.toolName}${R}${dur}${msg.toolSummary ? ` — ${D}${msg.toolSummary?.slice(0, 120)}${R}` : ''}`;
}

/**
 * Build a formatted string for a system notification message.
 * @param msg - The system message to format.
 * @param theme - The active theme for coloring.
 * @returns ANSI-formatted dimmed string.
 */
export function buildSystemMessage(msg: ChatMessage, theme: Theme): string {
  const P = theme.colors;
  return `${D}${fg(P.sysText)}${msg.text}${R}`;
}

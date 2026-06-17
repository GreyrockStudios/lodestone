/**
 * Lodestone — TUI Chat Streaming & Message Rendering
 *
 * Manages the streaming state machine and message rendering
 * for the TUI chat interface. Extracted from tui-chat.ts.
 */

import { TUI, Container, Spacer, Markdown, Text } from '@earendil-works/pi-tui';
import { ChatMessage, buildUserMessage, buildAssistantMessage, buildToolMessage, buildSystemMessage } from './messages.js';
import { Theme, getTheme, DEFAULT_THEME } from './theme.js';

const R = '\x1B[0m';

export type StatusState = 'ready' | 'thinking' | 'tool' | 'streaming' | 'error' | 'setup';

/**
 * Manages the chat log, message rendering, and streaming state.
 */
export class ChatRenderer {
  private chatLog: Container;
  private tui: TUI;
  private theme: Theme;
  private messages: ChatMessage[] = [];
  private msgCount: number = 0;
  private scrollOffset: number = 0;

  // Streaming state
  private streamingMd: Markdown | null = null;
  private streamingWrapper: Container | null = null;
  private streamingBuffer: string = '';

  // Status bar
  private statusText: Text;
  private displayName: string = 'Lodestone';
  private modelName: string = '';

  constructor(chatLog: Container, statusText: Text, tui: TUI, themeName?: string) {
    this.chatLog = chatLog;
    this.statusText = statusText;
    this.tui = tui;
    this.theme = getTheme(themeName || DEFAULT_THEME);
  }

  get Theme(): Theme { return this.theme; }
  get Messages(): ChatMessage[] { return this.messages; }
  get MsgCount(): number { return this.msgCount; }
  get ScrollOffset(): number { return this.scrollOffset; }
  get IsStreaming(): boolean { return this.streamingMd !== null; }
  get StreamingBuffer(): string { return this.streamingBuffer; }

  setDisplayName(name: string) { this.displayName = name; }
  setModelName(name: string) { this.modelName = name; }

  incrementMsgCount(): number {
    this.msgCount = this.messages.filter(m => m.role === 'user').length;
    return this.msgCount;
  }

  /**
   * Add a message to the messages array and render it.
   */
  addMessage(msg: ChatMessage): void {
    this.scrollOffset = 0; // Auto-scroll to bottom on new message
    this.messages.push(msg);
    this._renderMessage(msg);
  }

  /**
   * Add a message to the array only (no rendering). Used for system
   * messages during boot or when rendering is handled differently.
   */
  pushMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    if (msg.role === 'user') {
      this.msgCount = this.messages.filter(m => m.role === 'user').length;
    }
  }

  /**
   * Start a new streaming assistant message.
   */
  startStreamingMessage(): void {
    this.scrollOffset = 0;
    this.streamingBuffer = '';
    this.streamingMd = new Markdown('', 1, 1, this.theme.markdown as any);
    this.streamingWrapper = new Container();
    this.streamingWrapper.addChild(this.streamingMd);
    this.streamingWrapper.addChild(new Spacer(1));
    this.chatLog.addChild(this.streamingWrapper);
  }

  /**
   * Append text to the current streaming message.
   */
  appendStreamingText(delta: string): void {
    this.streamingBuffer += delta;
    if (this.streamingMd) {
      this.streamingMd.setText(`**${this.theme.statusBar.icon} ${this.displayName}** ${'\x1B[2m'}${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}${R} ${'\x1B[2m'}streaming...${R}\n${this.streamingBuffer}`);
      this.tui.requestRender();
    }
  }

  /**
   * Finish the current streaming message, replacing it with the final rendered version.
   */
  finishStreamingMessage(msg: ChatMessage): void {
    if (this.streamingMd && this.streamingWrapper) {
      this.streamingMd.setText(buildAssistantMessage(msg, this.theme, this.displayName));
      this.tui.requestRender();
    }
    this.streamingMd = null;
    this.streamingWrapper = null;
    this.streamingBuffer = '';
  }

  /**
   * Update the last tool message in the messages array with result data.
   */
  updateToolResult(toolName: string, success: boolean, durationMs: number, summary: string): void {
    const lastTool = [...this.messages].reverse().find(m => m.role === 'tool' && m.toolName === toolName);
    if (lastTool) {
      lastTool.toolSuccess = success;
      lastTool.toolDuration = durationMs;
      lastTool.toolSummary = summary?.slice(0, 120) || '';
    }
  }

  /**
   * Update the status bar with current state.
   */
  updateStatus(state: StatusState, detail?: string, channelInfo?: string): void {
    const P = this.theme.colors;
    const B = '\x1B[1m';
    const D = '\x1B[2m';
    const spinnerFrame = this.theme.spinner[0]; // Simple; caller can animate

    const icon = state === 'ready' ? `${'\x1B[38;2;124;211;165m'}✓${R}`
      : state === 'thinking' ? `${'\x1B[38;2;246;196;83m'}⚡${R} ${spinnerFrame}`
      : state === 'tool' ? `${'\x1B[38;2;246;196;83m'}⚙${R} ${spinnerFrame}`
      : state === 'streaming' ? `${'\x1B[38;2;246;196;83m'}${this.theme.statusBar.icon}${R} ${spinnerFrame}`
      : state === 'setup' ? `${'\x1B[38;2;246;196;83m'}${this.theme.statusBar.icon}${R} ${spinnerFrame}`
      : `${'\x1B[38;2;220;38;38m'}✗${R}`;

    const stateLabel = state === 'ready' ? 'Ready'
      : state === 'thinking' ? 'Thinking'
      : state === 'tool' ? `Tool: ${detail || '...'}`
      : state === 'streaming' ? 'Streaming'
      : state === 'setup' ? (detail || 'Setup')
      : 'Error';

    const msgLabel = `${this.msgCount} msgs`;

    let channelLabel = '';
    if (channelInfo) {
      channelLabel = ` ${D}${'\x1B[38;2;123;127;135m'}│${R} ${channelInfo}`;
    }

    const scrollLabel = this.scrollOffset > 0 ? ` ${D}${'\x1B[38;2;123;127;135m'}│${R} ${'\x1B[38;2;251;191;36m'}↑${this.scrollOffset}${R}` : '';

    this.statusText.setText(
      ` ${B}${'\x1B[38;2;246;196;83m'}${this.theme.statusBar.icon}${R} ${this.displayName} ${D}${'\x1B[38;2;123;127;135m'}│${R} ${this.modelName || '...'} ${D}${'\x1B[38;2;123;127;135m'}│${R} ${icon} ${stateLabel} ${D}${'\x1B[38;2;123;127;135m'}│${R} ${msgLabel}${channelLabel}${scrollLabel} ${detail && state !== 'tool' ? `${D}${'\x1B[38;2;123;127;135m'}│${R} ${detail}` : ''} `
    );
    this.tui.requestRender();
  }

  /**
   * Refresh all messages — re-renders any messages that aren't visually in chatLog yet.
   */
  refreshAll(): void {
    const currentCount = this.chatLog.children.length;
    const expectedCount = this.messages.length;
    if (currentCount < expectedCount) {
      for (let i = currentCount; i < expectedCount; i++) {
        this._renderMessage(this.messages[i]);
      }
    }
    this.tui.requestRender();
  }

  /**
   * Scroll the chat view.
   */
  scrollUp(lines: number = 10): void {
    this.scrollOffset = Math.min(this.scrollOffset + lines, 1000);
  }

  scrollDown(lines: number = 10): void {
    this.scrollOffset = Math.max(this.scrollOffset - lines, 0);
  }

  scrollToTop(): void {
    this.scrollOffset = 1000;
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _renderMessage(msg: ChatMessage): void {
    const md = new Markdown('', 1, 1, this.theme.markdown as any);
    let content: string;
    if (msg.role === 'user') content = buildUserMessage(msg, this.theme);
    else if (msg.role === 'assistant') content = buildAssistantMessage(msg, this.theme, this.displayName);
    else if (msg.role === 'tool') content = buildToolMessage(msg, this.theme);
    else content = buildSystemMessage(msg, this.theme);

    md.setText(content);

    const wrapper = new Container();
    wrapper.addChild(md);
    wrapper.addChild(new Spacer(1));
    this.chatLog.addChild(wrapper);
  }
}
/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core - Session Management
 *
 * Manages agent sessions: creation, resumption, context management,
 * and compaction when context gets too long.
 */

import { randomUUID } from 'crypto';

// ─── Session Types ──────────────────────────────────────────────────────────

export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SessionMessage {
  id: string;
  role: SessionRole;
  content: string;
  timestamp: string;
  /** Tool call ID if this is a tool result */
  toolCallId?: string;
  /** Tool name if this is a tool result */
  toolName?: string;
  /** Token count for this message */
  tokenCount?: number;
  /** Whether this message has been compacted (summarized) */
  compacted?: boolean;
  /** Metadata attached to this message */
  metadata?: Record<string, unknown>;
}

export interface SessionState {
  /** Current task description */
  currentTask: string;
  /** Progress indicator */
  progress: string;
  /** What's blocking progress (if anything) */
  blockedBy?: string;
  /** Next steps */
  nextSteps: string[];
  /** Files recently worked on */
  recentFiles: string[];
  /** Current mood/state */
  mood?: 'focused' | 'stuck' | 'waiting' | 'done';
  /** Open questions for the user */
  openQuestions?: string[];
}

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  state: SessionState;
  /** Total tokens used in this session */
  totalTokens: number;
  /** Maximum context window */
  contextWindow: number;
  /** Session metadata */
  metadata: Record<string, unknown>;
}

// ─── Compaction Strategy ───────────────────────────────────────────────────

export interface CompactionConfig {
  /** Compact when context exceeds this percentage of context window */
  thresholdPercent: number;
  /** Keep this many recent messages verbatim */
  keepRecentCount: number;
  /** Always keep system prompt */
  keepSystemPrompt: boolean;
}

const DEFAULT_COMPACTION: CompactionConfig = {
  thresholdPercent: 0.5, // Compact at 50%
  keepRecentCount: 10,
  keepSystemPrompt: true,
};

// ─── Session Manager ────────────────────────────────────────────────────────

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private compactionConfig: CompactionConfig;

  constructor(compactionConfig?: Partial<CompactionConfig>) {
    this.compactionConfig = { ...DEFAULT_COMPACTION, ...compactionConfig };
  }

  /** Create a new session */
  create(contextWindow: number, initialState?: Partial<SessionState>): Session {
    const session: Session = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      state: {
        currentTask: initialState?.currentTask || '',
        progress: initialState?.progress || 'initialized',
        nextSteps: initialState?.nextSteps || [],
        recentFiles: initialState?.recentFiles || [],
        mood: initialState?.mood,
        openQuestions: initialState?.openQuestions,
        ...initialState,
      },
      totalTokens: 0,
      contextWindow,
      metadata: {},
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Get an existing session */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Add a message to a session */
  addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'timestamp'>): SessionMessage {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found. Use engine.createSession() to create a new session first.`);

    const fullMessage: SessionMessage = {
      ...message,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    session.messages.push(fullMessage);
    session.totalTokens += message.tokenCount || 0;
    session.updatedAt = new Date().toISOString();

    return fullMessage;
  }

  /** Check if a session needs compaction */
  needsCompaction(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const threshold = session.contextWindow * this.compactionConfig.thresholdPercent;
    return session.totalTokens > threshold;
  }

  /** Compact a session - summarize the middle, keep the edges */
  compact(
    sessionId: string,
    summaryFn: (messages: SessionMessage[]) => Promise<string>
  ): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found. Use engine.createSession() to create a new session first.`);

    const { keepRecentCount, keepSystemPrompt } = this.compactionConfig;

    // Split messages into: system prompt | middle | recent
    const systemMessages: SessionMessage[] = [];
    const middleMessages: SessionMessage[] = [];
    const recentMessages: SessionMessage[] = [];

    let systemDone = false;
    const recentStart = Math.max(0, session.messages.length - keepRecentCount);

    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];

      if (keepSystemPrompt && msg.role === 'system' && !systemDone) {
        systemMessages.push(msg);
      } else {
        systemDone = true;
        if (i >= recentStart) {
          recentMessages.push(msg);
        } else {
          middleMessages.push(msg);
        }
      }
    }

    // If nothing to compact, return as-is
    if (middleMessages.length === 0) {
      return Promise.resolve(session);
    }

    // Summarize the middle
    return summaryFn(middleMessages).then(summary => {
      const compactedMessage: SessionMessage = {
        id: randomUUID(),
        role: 'system',
        content: `## Session State Block (compacted)\n${summary}`,
        timestamp: new Date().toISOString(),
        compacted: true,
        tokenCount: Math.floor(summary.length / 4), // Rough estimate
      };

      session.messages = [
        ...systemMessages,
        compactedMessage,
        ...recentMessages,
      ];
      session.updatedAt = new Date().toISOString();

      return session;
    });
  }

  /** Update session state */
  updateState(sessionId: string, update: Partial<SessionState>): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found. Use engine.createSession() to create a new session first.`);

    session.state = { ...session.state, ...update };
    session.updatedAt = new Date().toISOString();
  }

  /** Get all active sessions */
  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** Delete a session */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Clean up stale sessions — remove sessions older than maxAgeMs with no recent activity */
  cleanupStale(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      const lastActivity = new Date(session.updatedAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Get session count */
  count(): number {
    return this.sessions.size;
  }
}
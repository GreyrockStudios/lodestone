/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Session Persistence
 *
 * SQLite-backed persistence for agent sessions. Survives restarts.
 * Uses better-sqlite3 (synchronous, fast, no native async needed).
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Session, SessionMessage, SessionState } from './manager.js';
import { Logger, ChildLogger } from '../utils/logger.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  messages TEXT NOT NULL,        -- JSON-serialized SessionMessage[]
  state TEXT NOT NULL,           -- JSON-serialized SessionState
  total_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'  -- JSON-serialized metadata
);
`;

// ─── Session Persistence ───────────────────────────────────────────────────

export class SessionPersistence {
  private db: Database.Database;
  private logger: Logger | ChildLogger;
  private cache: Map<string, Session> = new Map();

  // Prepared statements (reused for performance)
  private stmtSave: Database.Statement;
  private stmtLoad: Database.Statement;
  private stmtLoadAll: Database.Statement;
  private stmtDelete: Database.Statement;

  constructor(dbPath: string, logger?: Logger | ChildLogger) {
    this.logger = logger || new Logger();

    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      this.logger.info(`Session persistence: created directory ${dir}`);
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create schema
    this.db.exec(SCHEMA_SQL);

    // Prepare statements
    this.stmtSave = this.db.prepare(`
      INSERT INTO sessions (id, created_at, updated_at, messages, state, total_tokens, context_window, metadata)
      VALUES (@id, @created_at, @updated_at, @messages, @state, @total_tokens, @context_window, @metadata)
      ON CONFLICT(id) DO UPDATE SET
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        messages = excluded.messages,
        state = excluded.state,
        total_tokens = excluded.total_tokens,
        context_window = excluded.context_window,
        metadata = excluded.metadata
    `);

    this.stmtLoad = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.stmtLoadAll = this.db.prepare('SELECT * FROM sessions');
    this.stmtDelete = this.db.prepare('DELETE FROM sessions WHERE id = ?');

    this.logger.info('Session persistence initialized', { dbPath });
  }

  /** Save (upsert) a session to SQLite. Also updates the in-memory cache. */
  saveSession(session: Session): void {
    this.cache.set(session.id, session);

    this.stmtSave.run({
      id: session.id,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      messages: JSON.stringify(session.messages),
      state: JSON.stringify(session.state),
      total_tokens: session.totalTokens,
      context_window: session.contextWindow,
      metadata: JSON.stringify(session.metadata),
    });
  }

  /** Load a single session by ID. Returns from cache if available. */
  loadSession(id: string): Session | undefined {
    // Check cache first
    const cached = this.cache.get(id);
    if (cached) return cached;

    const row = this.stmtLoad.get(id) as SessionRow | undefined;
    if (!row) return undefined;

    const session = this.deserializeSession(row);
    this.cache.set(id, session);
    return session;
  }

  /** Load all sessions from SQLite. Returns an array of Session objects. */
  loadAllSessions(): Session[] {
    const rows = this.stmtLoadAll.all() as SessionRow[];
    const sessions: Session[] = [];

    for (const row of rows) {
      const session = this.deserializeSession(row);
      this.cache.set(session.id, session);
      sessions.push(session);
    }

    this.logger.info('Loaded sessions from SQLite', { count: sessions.length });
    return sessions;
  }

  /** Delete a session from SQLite and cache. */
  deleteSession(id: string): boolean {
    this.cache.delete(id);
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    this.cache.clear();
    this.logger.info('Session persistence closed');
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private deserializeSession(row: SessionRow): Session {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: JSON.parse(row.messages) as SessionMessage[],
      state: JSON.parse(row.state) as SessionState,
      totalTokens: row.total_tokens,
      contextWindow: row.context_window,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    };
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  messages: string;
  state: string;
  total_tokens: number;
  context_window: number;
  metadata: string;
}
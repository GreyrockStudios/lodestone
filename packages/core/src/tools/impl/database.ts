/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — Database
 *
 * Query and manage SQLite or PostgreSQL databases.
 * Uses better-sqlite3 for SQLite (lazy import) and pg for Postgres (lazy import).
 * All queries use parameterized inputs — no string interpolation.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

// Minimal type declarations for the lazy-imported modules
interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }; get(...params: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
  pragma(str: string): unknown;
}

interface PostgresClient {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number; command: string }>;
  end(): Promise<void>;
}

export class DatabaseTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'database',
    name: 'Database',
    description: 'Query and manage SQLite or PostgreSQL databases. Supports query, execute, migrate, list-tables, and schema.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: query, execute, migrate, list-tables, schema', required: true, enum: ['query', 'execute', 'migrate', 'list-tables', 'schema'] },
      { name: 'sql', type: 'string', description: 'SQL statement (for query/execute)', required: false },
      { name: 'params', type: 'array', description: 'Parameterized query values', required: false, items: { name: 'value', type: 'string', description: 'A parameter value', required: true } },
      { name: 'database', type: 'string', description: 'DB path or connection string (default: workspaceRoot/data/lodestone.db)', required: false },
      { name: 'table', type: 'string', description: 'Table name (for schema action)', required: false },
    ],
    sideEffects: true, // true for execute/migrate, overridden in execute for read-only
    requiresApproval: true, // true for execute/migrate, overridden for read-only
    timeout: 15000,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    // Determine if this is a read-only action
    const readOnly = action === 'query' || action === 'list-tables' || action === 'schema';

    try {
      const database = (params.database as string) || join(context.workspaceRoot, 'data', 'lodestone.db');
      const isPostgres = database.startsWith('postgres://') || database.startsWith('postgresql://');

      if (isPostgres) {
        return await this.executePostgres(action, params, database, start, readOnly);
      } else {
        return await this.executeSqlite(action, params, database, start, context, readOnly);
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Database action "${action}" failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
  }

  // ─── SQLite ───────────────────────────────────────────────

  private async executeSqlite(
    action: string,
    params: Record<string, unknown>,
    database: string,
    start: number,
    context: ToolContext,
    _readOnly: boolean,
  ): Promise<ToolResult> {
    // Lazy import better-sqlite3
    let Database: new (path: string, opts?: Record<string, unknown>) => SqliteDatabase;
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default;
    } catch {
      throw new Error('better-sqlite3 is not installed. Install it with: npm install better-sqlite3. This is required for SQLite database operations.');
    }

    // Ensure directory exists for SQLite
    const dir = dirname(database);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new Database(database, { readonly: _readOnly && !existsSync(database) ? false : false });

    try {
      switch (action) {
        case 'query': {
          const sql = params.sql as string;
          if (!sql) return this.missingParam('sql', start);
          const queryParams = (params.params as unknown[]) || [];
          const stmt = db.prepare(sql);
          const rows = stmt.all(...queryParams);
          return {
            success: true,
            data: { rows, count: Array.isArray(rows) ? rows.length : 0 },
            summary: `Query returned ${Array.isArray(rows) ? rows.length : 0} row(s)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'execute': {
          const sql = params.sql as string;
          if (!sql) return this.missingParam('sql', start);
          const execParams = (params.params as unknown[]) || [];
          const stmt = db.prepare(sql);
          const result = stmt.run(...execParams);
          return {
            success: true,
            data: { changes: result.changes, lastInsertRowid: result.lastInsertRowid },
            summary: `Executed: ${result.changes} row(s) affected`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'migrate': {
          const sql = params.sql as string;
          if (!sql) return this.missingParam('sql', start);
          // Execute multiple statements
          db.exec(sql);
          return {
            success: true,
            data: { migrated: true },
            summary: 'Migration executed successfully',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list-tables': {
          const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
          const rows = stmt.all() as { name: string }[];
          return {
            success: true,
            data: { tables: rows.map(r => r.name) },
            summary: `${rows.length} table(s)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'schema': {
          const table = params.table as string;
          if (!table) return this.missingParam('table', start);
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
            return { success: false, data: null, summary: 'Invalid table name', error: 'Table name must be alphanumeric + underscore only', durationMs: Date.now() - start, includeInContext: true };
          }
          const stmt = db.prepare(`PRAGMA table_info(${table})`);
          const columns = stmt.all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
          return {
            success: true,
            data: { table, columns },
            summary: `Schema for ${table}: ${columns.length} column(s)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } finally {
      db.close();
    }
  }

  // ─── PostgreSQL ───────────────────────────────────────────

  private async executePostgres(
    action: string,
    params: Record<string, unknown>,
    connectionString: string,
    start: number,
    _readOnly: boolean,
  ): Promise<ToolResult> {
    // Lazy import pg
    let Client: new (config: Record<string, unknown>) => PostgresClient;
    try {
      // @ts-ignore — pg may not be installed
      const mod = await import('pg');
      Client = mod.Client;
    } catch {
      throw new Error('pg is not installed. Install it with: npm install pg. This is required for PostgreSQL database operations.');
    }

    const client = new Client({ connectionString });

    try {
      await client.connect();

      switch (action) {
        case 'query': {
          const sql = params.sql as string;
          if (!sql) return this.missingParam('sql', start);
          const queryParams = (params.params as unknown[]) || [];
          const result = await client.query(sql, queryParams);
          return {
            success: true,
            data: { rows: result.rows, count: result.rows.length },
            summary: `Query returned ${result.rows.length} row(s)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'execute': {
          const sql = params.sql as string;
          if (!sql) return this.missingParam('sql', start);
          const execParams = (params.params as unknown[]) || [];
          const result = await client.query(sql, execParams);
          return {
            success: true,
            data: { changes: result.rowCount, lastInsertRowid: null },
            summary: `Executed: ${result.rowCount} row(s) affected`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'migrate': {
          const sql = params.sql as string;
          if (!sql) return this.missingParam('sql', start);
          await client.query(sql);
          return {
            success: true,
            data: { migrated: true },
            summary: 'Migration executed successfully',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'list-tables': {
          const result = await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
          );
          return {
            success: true,
            data: { tables: (result.rows as { tablename: string }[]).map(r => r.tablename) },
            summary: `${result.rows.length} table(s)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'schema': {
          const table = params.table as string;
          if (!table) return this.missingParam('table', start);
          const result = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default 
             FROM information_schema.columns 
             WHERE table_name = $1 
             ORDER BY ordinal_position`,
            [table]
          );
          return {
            success: true,
            data: { table, columns: result.rows },
            summary: `Schema for ${table}: ${result.rows.length} column(s)`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } finally {
      await client.end();
    }
  }

  // ─── Helpers ──────────────────────────────────────────────

  private missingParam(name: string, start: number): ToolResult {
    return {
      success: false, data: null,
      summary: `Missing required parameter: ${name}`,
      error: `Missing parameter: ${name}`,
      durationMs: Date.now() - start, includeInContext: false,
    };
  }
}
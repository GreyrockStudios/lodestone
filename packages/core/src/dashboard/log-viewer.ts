/**
 * Lodestone Dashboard — Log Viewer
 *
 * Reads structured logs from the Lodestone log file, parses JSON or text lines,
 * supports filtering by level/module, and provides a tail stream via SSE.
 *
 * Used by the dashboard server for /api/logs and /api/logs/stream endpoints.
 */

import { readFile, open, type FileHandle } from 'fs/promises';
import { existsSync, statSync, watchFile, unwatchFile } from 'fs';
import { getLogger, type ChildLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LogEntry {
  level: string;
  timestamp: string;
  message: string;
  module?: string;
  [key: string]: unknown;
}

export interface LogQueryOptions {
  limit?: number;
  level?: string;
  module?: string;
  since?: Date;
}

// ─── Log Viewer ──────────────────────────────────────────────────────────────

export class LogViewer {
  private logFile: string;
  private logger: ChildLogger;

  constructor(logFile: string) {
    this.logFile = logFile;
    this.logger = getLogger('log-viewer') as ChildLogger;
  }

  /**
   * Read recent logs from the file, optionally filtered.
   * Returns entries in chronological order (oldest first).
   */
  async getRecentLogs(opts: LogQueryOptions = {}): Promise<LogEntry[]> {
    if (!existsSync(this.logFile)) {
      return [];
    }

    const content = await readFile(this.logFile, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    let entries: LogEntry[] = lines.map((line) => this.parseLine(line));

    // Filter by level
    if (opts.level) {
      const levelLower = opts.level.toLowerCase();
      entries = entries.filter((e) => e.level.toLowerCase() === levelLower);
    }

    // Filter by module
    if (opts.module) {
      const moduleLower = opts.module.toLowerCase();
      entries = entries.filter(
        (e) => e.module && e.module.toLowerCase().includes(moduleLower),
      );
    }

    // Filter by since
    if (opts.since) {
      const sinceMs = opts.since.getTime();
      entries = entries.filter((e) => {
        if (!e.timestamp) return false;
        const ts = new Date(e.timestamp).getTime();
        return ts >= sinceMs;
      });
    }

    // Limit (take the last N entries)
    if (opts.limit && opts.limit > 0) {
      entries = entries.slice(-opts.limit);
    }

    return entries;
  }

  /**
   * Tail new log entries. Calls callback for each new line appended.
   * Returns a stop function.
   */
  tailLogs(callback: (entry: LogEntry) => void): () => void {
    let stopped = false;
    let position = 0;

    // Start from end of file if it exists
    if (existsSync(this.logFile)) {
      try {
        const stats = statSync(this.logFile);
        position = stats.size;
      } catch {
        // ignore
      }
    }

    // Use watchFile (polling-based) — works reliably across platforms
    watchFile(this.logFile, { persistent: false, interval: 500 }, async () => {
      if (stopped) return;

      try {
        if (!existsSync(this.logFile)) {
          // File might have been rotated away
          position = 0;
          return;
        }

        const stats = statSync(this.logFile);

        // File was truncated or rotated — reset
        if (stats.size < position) {
          position = 0;
        }

        const newSize = stats.size - position;
        if (newSize <= 0) return;

        const handle: FileHandle = await open(this.logFile, 'r');
        try {
          const buffer = Buffer.alloc(newSize);
          await handle.read(buffer, 0, newSize, position);
          position = stats.size;

          const newContent = buffer.toString('utf-8');
          const lines = newContent.split('\n').filter((l) => l.trim().length > 0);

          for (const line of lines) {
            if (stopped) break;
            const entry = this.parseLine(line);
            callback(entry);
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        this.logger.debug('Error reading log tail', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Return stop function
    return () => {
      stopped = true;
      try {
        unwatchFile(this.logFile);
      } catch {
        // ignore
      }
    };
  }

  /**
   * Get available modules from the log file (for filter dropdown).
   */
  async getModules(): Promise<string[]> {
    if (!existsSync(this.logFile)) {
      return [];
    }

    const content = await readFile(this.logFile, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    const modules = new Set<string>();
    for (const line of lines) {
      const entry = this.parseLine(line);
      if (entry.module) {
        modules.add(entry.module);
      }
    }

    return Array.from(modules).sort();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Parse a single log line into a LogEntry.
   * Supports JSON lines and plain text (best-effort).
   */
  private parseLine(line: string): LogEntry {
    const trimmed = line.trim();

    // Try JSON parse first
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.level && parsed.timestamp && parsed.message) {
        return parsed as LogEntry;
      }
      // JSON but missing required fields — still useful
      return {
        level: parsed.level || 'info',
        timestamp: parsed.timestamp || new Date().toISOString(),
        message: parsed.message || trimmed,
        ...parsed,
      };
    } catch {
      // Not JSON — parse as text
      return this.parseTextLine(trimmed);
    }
  }

  /**
   * Parse a plain text log line.
   * Expected format: "2026-06-17T12:00:00.000Z INFO  [module] message {meta}"
   */
  private parseTextLine(line: string): LogEntry {
    // Try to match: timestamp LEVEL [module] message
    const match = line.match(
      /^(\d{4}-\d{2}-\d{2}T[\d:.\-]+Z?)\s+(\w+)\s+(?:\[([^\]]+)\]\s+)?(.+)$/,
    );

    if (match) {
      return {
        timestamp: match[1],
        level: match[2].toLowerCase(),
        module: match[3] || undefined,
        message: match[4],
      };
    }

    // Fallback — whole line is message
    return {
      level: 'info',
      timestamp: new Date().toISOString(),
      message: line,
    };
  }
}
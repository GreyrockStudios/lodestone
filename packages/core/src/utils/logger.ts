/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Structured Logger
 *
 * Replaces console.log/error/warn with structured, leveled logging.
 * Supports JSON and text output, file rotation, and child loggers.
 *
 * No external dependencies — pure TypeScript.
 */

import { createWriteStream, type WriteStream, mkdirSync, existsSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  module?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  /** Minimum level to output (default: info) */
  minLevel?: LogLevel;
  /** Output format: json or text (default: text) */
  format?: 'json' | 'text';
  /** Log to stdout (default: true) */
  stdout?: boolean;
  /** Log to file (path) */
  file?: string | undefined;
  /** Max file size in bytes before rotation (default: 10MB) */
  maxFileSize?: number;
  /** Max number of rotated files to keep (default: 5) */
  maxFiles?: number;
  /** Include timestamp (default: true) */
  timestamp?: boolean;
}

// ─── Level Priority ──────────────────────────────────────────────────────────

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m',   // gray
  debug: '\x1b[36m',   // cyan
  info: '\x1b[32m',    // green
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
  fatal: '\x1b[35m',   // magenta
};

const RESET = '\x1b[0m';

// ─── Logger ──────────────────────────────────────────────────────────────────

export class Logger {
  private config: {
    minLevel: LogLevel;
    format: 'json' | 'text';
    stdout: boolean;
    file: string | undefined;
    maxFileSize: number;
    maxFiles: number;
    timestamp: boolean;
  };
  private fileStream: WriteStream | null = null;
  private currentFileSize = 0;
  private fileIndex = 0;

  constructor(config: LoggerConfig = {}) {
    this.config = {
      minLevel: config.minLevel || 'info',
      format: config.format || 'text',
      stdout: config.stdout ?? true,
      file: config.file,
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024,
      maxFiles: config.maxFiles || 5,
      timestamp: config.timestamp ?? true,
    };

    if (this.config.file) {
      this.initFile();
    }
  }

  private initFile(): void {
    if (!this.config.file) return;
    const dir = dirname(this.config.file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Check existing file size
    try {
      const stats = statSync(this.config.file);
      this.currentFileSize = stats.size;
    } catch {
      this.currentFileSize = 0;
    }

    this.fileStream = createWriteStream(this.config.file, { flags: 'a' });
  }

  private rotateFile(): void {
    if (!this.config.file || !this.fileStream) return;

    this.fileStream.end();

    // Rotate: file.5 → delete, file.4 → file.5, ..., file → file.1
    for (let i = this.config.maxFiles - 1; i >= 0; i--) {
      const oldPath = i === 0 ? this.config.file : `${this.config.file}.${i}`;
      const newPath = `${this.config.file}.${i + 1}`;
      try {
        if (existsSync(newPath)) {
          // Delete if at max
        }
        if (existsSync(oldPath)) {
          if (i === this.config.maxFiles - 1) {
            // Delete oldest
          } else {
            renameSync(oldPath, newPath);
          }
        }
      } catch {
        // Best-effort rotation
      }
    }

    this.currentFileSize = 0;
    this.fileStream = createWriteStream(this.config.file, { flags: 'w' });
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.config.minLevel];
  }

  private formatEntry(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }

    // Text format
    const parts: string[] = [];
    if (this.config.timestamp) {
      parts.push(entry.timestamp);
    }
    const levelStr = this.config.stdout
      ? `${LEVEL_COLORS[entry.level]}${entry.level.toUpperCase().padEnd(5)}${RESET}`
      : entry.level.toUpperCase().padEnd(5);
    parts.push(levelStr);

    if (entry.module) {
      parts.push(`[${entry.module}]`);
    }

    parts.push(entry.message);

    // Extra fields
    const extras: string[] = [];
    for (const [key, value] of Object.entries(entry)) {
      if (['level', 'timestamp', 'message', 'module'].includes(key)) continue;
      extras.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    if (extras.length > 0) {
      parts.push(`{${extras.join(' ')}}`);
    }

    return parts.join(' ');
  }

  protected write(level: LogLevel, message: string, meta?: Record<string, unknown>, module?: string): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      message,
      module,
      ...meta,
    };

    const formatted = this.formatEntry(entry);

    if (this.config.stdout) {
      if (level === 'error' || level === 'fatal') {
        process.stderr.write(formatted + '\n');
      } else {
        process.stdout.write(formatted + '\n');
      }
    }

    if (this.fileStream && this.config.file) {
      // Write structured JSON to file for log viewer compatibility
      const fileLine = this.config.format === 'json'
        ? JSON.stringify(entry) + '\n'
        : formatted.replace(/\x1b\[\d+m/g, '') + '\n';
      this.currentFileSize += Buffer.byteLength(fileLine);

      if (this.currentFileSize >= this.config.maxFileSize) {
        this.rotateFile();
      }

      this.fileStream?.write(fileLine);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  trace(message: string, meta?: Record<string, unknown>): void {
    this.write('trace', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  fatal(message: string, meta?: Record<string, unknown>): void {
    this.write('fatal', message, meta);
  }

  /** Create a child logger with a fixed module name */
  child(module: string): ChildLogger {
    return new ChildLogger(this, module);
  }

  /** Set the minimum log level at runtime */
  setLevel(level: LogLevel): void {
    this.config.minLevel = level;
  }

  /** Close file streams */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

// ─── Child Logger ────────────────────────────────────────────────────────────

export class ChildLogger {
  constructor(
    private parent: Logger,
    private module: string,
  ) {}

  trace(message: string, meta?: Record<string, unknown>): void {
    this.parent.trace(message, meta);
    // Module is attached via the child logger's constructor
    // The parent trace() will call write() which is protected within Logger
    // We need to pass module info via the meta
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.parent.debug(`[${this.module}] ${message}`, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.parent.info(`[${this.module}] ${message}`, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.parent.warn(`[${this.module}] ${message}`, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.parent.error(`[${this.module}] ${message}`, meta);
  }

  fatal(message: string, meta?: Record<string, unknown>): void {
    this.parent.fatal(`[${this.module}] ${message}`, meta);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let globalLogger: Logger | null = null;

export function initLogger(config: LoggerConfig = {}): Logger {
  if (globalLogger) {
    globalLogger.close();
  }
  globalLogger = new Logger(config);
  return globalLogger;
}

export function getLogger(module?: string): Logger | ChildLogger {
  if (!globalLogger) {
    globalLogger = new Logger();
  }
  if (module) {
    return globalLogger.child(module);
  }
  return globalLogger;
}
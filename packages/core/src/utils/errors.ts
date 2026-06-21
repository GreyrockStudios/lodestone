/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Typed Error Classes
 *
 * Structured error hierarchy for deterministic error handling.
 * Each error type carries context for logging, debugging, and recovery.
 */

// ─── Base Error ────────────────────────────────────────────────────────────

export class LodestoneError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;
  public readonly recoverable: boolean;

  constructor(message: string, opts: { code?: string; context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = opts.code ?? this.constructor.name.replace('Error', '').toUpperCase();
    this.context = opts.context;
    this.recoverable = opts.recoverable ?? false;
    // Maintain proper stack trace (V8 only)
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): { name: string; code: string; message: string; context?: Record<string, unknown>; recoverable: boolean } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      recoverable: this.recoverable,
    };
  }
}

// ─── Configuration Errors ───────────────────────────────────────────────────

export class LodestoneConfigError extends LodestoneError {
  constructor(message: string, opts: { context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message, { code: 'CONFIG', recoverable: true, ...opts });
  }
}

// ─── LLM Errors ─────────────────────────────────────────────────────────────

export class LLMError extends LodestoneError {
  constructor(message: string, opts: { context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message, { code: 'LLM', recoverable: true, ...opts });
  }
}

// ─── Tool Errors ─────────────────────────────────────────────────────────────

export class ToolError extends LodestoneError {
  constructor(message: string, opts: { context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message, { code: 'TOOL', recoverable: true, ...opts });
  }
}

// ─── Channel Errors ──────────────────────────────────────────────────────────

export class ChannelError extends LodestoneError {
  constructor(message: string, opts: { context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message, { code: 'CHANNEL', recoverable: true, ...opts });
  }
}

// ─── Memory Errors ───────────────────────────────────────────────────────────

export class MemoryError extends LodestoneError {
  constructor(message: string, opts: { context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message, { code: 'MEMORY', recoverable: true, ...opts });
  }
}

// ─── Safety Errors ───────────────────────────────────────────────────────────

export class SafetyError extends LodestoneError {
  constructor(message: string, opts: { context?: Record<string, unknown>; recoverable?: boolean } = {}) {
    super(message, { code: 'SAFETY', recoverable: false, ...opts });
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Check if an error is a LodestoneError (vs generic Error) */
export function isLodestoneError(err: unknown): err is LodestoneError {
  return err instanceof LodestoneError;
}

/** Safely extract error message from unknown catch */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/** Safely extract error context from unknown catch */
export function errorContext(err: unknown): Record<string, unknown> | undefined {
  if (err instanceof LodestoneError) return err.context;
  return undefined;
}
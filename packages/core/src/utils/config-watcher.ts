/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Config Watcher
 *
 * Watches the config file for changes and notifies registered callbacks.
 * Debounces duplicate events (500ms) to avoid rapid-fire reloads.
 * Validates new config before firing callbacks.
 *
 * No external dependencies — uses built-in fs only.
 */

import { watch, type FSWatcher } from 'fs';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { Logger, getLogger } from './logger.js';
import { ConfigValidator, lodestoneSchema } from './config-validator.js';
import type { LodestoneConfig } from '../engine.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ReloadCallback = (newConfig: LodestoneConfig) => void;

export interface ConfigWatcherOptions {
  /** Path to the config file */
  path: string;
  /** Debounce time in ms (default: 500) */
  debounceMs?: number;
  /** Logger instance (optional) */
  logger?: Logger;
}

// ─── Config Watcher ─────────────────────────────────────────────────────────

export class ConfigWatcher {
  private path: string;
  private debounceMs: number;
  private logger: Logger | ReturnType<Logger['child']>;
  private watcher: FSWatcher | null = null;
  private callbacks: ReloadCallback[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private validator: ConfigValidator;
  private running = false;

  constructor(opts: ConfigWatcherOptions) {
    this.path = opts.path;
    this.debounceMs = opts.debounceMs ?? 500;
    this.logger = opts.logger ? opts.logger.child('config-watcher') : getLogger('config-watcher');
    this.validator = new ConfigValidator(lodestoneSchema);
  }

  /**
   * Start watching the config file.
   */
  start(): void {
    if (this.running) return;

    try {
      this.watcher = watch(this.path, { persistent: false }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          this.handleFileChange();
        }
      });
      this.running = true;
      this.logger.info('Config watcher started', { path: this.path });
    } catch (err) {
      this.logger.error('Failed to start config watcher', {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop watching the config file.
   */
  stop(): void {
    if (!this.running) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.running = false;
    this.logger.info('Config watcher stopped');
  }

  /**
   * Register a callback to be called when config changes are detected.
   */
  onReload(callback: ReloadCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Load and parse the config file.
   */
  loadConfig(): LodestoneConfig | null {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const config = parseYaml(raw) as LodestoneConfig;
      return config;
    } catch (err) {
      this.logger.error('Failed to load config file', {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Validate a config object. Returns true if valid.
   */
  validateConfig(config: unknown): boolean {
    const result = this.validator.validate(config as Record<string, unknown>);
    if (!result.valid) {
      this.logger.error('Config validation failed on reload', {
        errors: result.errors.map(e => `${e.path}: ${e.message}`),
      });
      return false;
    }
    return true;
  }

  /**
   * Check if the watcher is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private handleFileChange(): void {
    // Debounce — multiple events can fire for a single save
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload();
    }, this.debounceMs);
  }

  private reload(): void {
    this.logger.info('Config file changed, reloading...', { path: this.path });

    const newConfig = this.loadConfig();
    if (!newConfig) {
      this.logger.warn('Config reload skipped — failed to parse');
      return;
    }

    // Validate
    if (!this.validateConfig(newConfig)) {
      this.logger.warn('Config reload skipped — validation failed');
      return;
    }

    // Notify all callbacks
    this.logger.info('Config reloaded successfully, notifying handlers');
    for (const cb of this.callbacks) {
      try {
        cb(newConfig);
      } catch (err) {
        this.logger.error('Config reload callback error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
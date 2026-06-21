/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Scratch Buffer
 *
 * Session-scoped key-value store that survives context compaction.
 * Used for tracking files read, current task state, and short-lived data
 * that needs to persist across context window boundaries.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScratchEntry {
  key: string;
  value: string;
  category?: string;
  createdAt: number;
  expiresAt: number | null; // null = no expiry
}

export interface ScratchConfig {
  /** Path to the scratch buffer database file */
  dbPath: string;
  /** Default TTL in milliseconds (null = no expiry) */
  defaultTtlMs: number | null;
}

// ─── Scratch Buffer ─────────────────────────────────────────────────────────

export class ScratchBuffer implements Pick<import('../tools/definitions.js').MemoryAccess, 'scratchGet' | 'scratchSet'> {
  private config: ScratchConfig;
  private data: Map<string, ScratchEntry> = new Map();
  private loaded = false;

  constructor(config: ScratchConfig) {
    this.config = config;
  }

  /** Load the scratch buffer from disk */
  async init(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await readFile(this.config.dbPath, 'utf-8');
      const entries: ScratchEntry[] = JSON.parse(data);
      const now = Date.now();

      for (const entry of entries) {
        // Skip expired entries
        if (entry.expiresAt && entry.expiresAt < now) continue;
        this.data.set(entry.key, entry);
      }
    } catch {
      // File doesn't exist yet — start empty
    }

    this.loaded = true;
  }

  /** Get a value by key */
  async scratchGet(key: string): Promise<string | null> {
    await this.ensureInit();

    const entry = this.data.get(key);
    if (!entry) return null;

    // Check expiry
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }

    return entry.value;
  }

  /** Set a value with optional TTL and category */
  async scratchSet(key: string, value: string, ttlMs?: number, category?: string): Promise<void> {
    await this.ensureInit();

    const entry: ScratchEntry = {
      key,
      value,
      category,
      createdAt: Date.now(),
      expiresAt: ttlMs ? Date.now() + ttlMs : this.config.defaultTtlMs ? Date.now() + this.config.defaultTtlMs : null,
    };

    this.data.set(key, entry);
    await this.persist();
  }

  /** Delete a key */
  async delete(key: string): Promise<void> {
    await this.ensureInit();
    this.data.delete(key);
    await this.persist();
  }

  /** List all keys, optionally filtered by category */
  async list(category?: string): Promise<string[]> {
    await this.ensureInit();
    this.evictExpired();

    const entries = Array.from(this.data.values());
    if (category) {
      return entries
        .filter(e => e.category === category)
        .map(e => e.key);
    }
    return entries.map(e => e.key);
  }

  /** Clear all entries, optionally filtered by category */
  async clear(category?: string): Promise<void> {
    await this.ensureInit();

    if (category) {
      for (const [key, entry] of this.data) {
        if (entry.category === category) {
          this.data.delete(key);
        }
      }
    } else {
      this.data.clear();
    }

    await this.persist();
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.data.delete(key);
      }
    }
  }

  private async persist(): Promise<void> {
    // Evict expired before persisting
    this.evictExpired();

    const entries = Array.from(this.data.values());
    const json = JSON.stringify(entries, null, 2);

    // Ensure directory exists
    await mkdir(dirname(this.config.dbPath), { recursive: true });
    await writeFile(this.config.dbPath, json, 'utf-8');
  }
}
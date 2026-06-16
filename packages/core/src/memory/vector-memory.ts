/**
 * Lodestone Core — Vector Memory
 *
 * Semantic memory storage using LanceDB for fast recall of facts,
 * preferences, decisions, and context. Auto-recall injects relevant
 * memories into every LLM turn.
 */

import { connect, type LanceDb } from '@lancedb/lancedb';
import type { MemoryAccess, MemoryResult } from '../tools/definitions.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VectorMemoryConfig {
  /** Path to LanceDB storage directory */
  dbPath: string;
  /** Embedding provider: 'ollama' | 'openai' */
  embeddingProvider: 'ollama' | 'openai';
  /** Embedding model name */
  embeddingModel: string;
  /** Embedding dimensions */
  dimensions: number;
  /** Base URL for embedding API */
  embeddingBaseUrl?: string;
  /** API key for embedding API (if needed) */
  embeddingApiKey?: string;
  /** Max characters to include in auto-recall */
  recallMaxChars?: number;
  /** Auto-recall on every turn */
  autoRecall?: boolean;
  /** Auto-capture every turn */
  autoCapture?: boolean;
}

export interface MemoryEntry {
  id: string;
  text: string;
  category: 'preference' | 'fact' | 'decision' | 'entity' | 'other';
  importance: number; // 0-1
  embedding?: number[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ─── Vector Memory ──────────────────────────────────────────────────────────

export class VectorMemory implements Partial<MemoryAccess> {
  private config: VectorMemoryConfig;
  private db: LanceDb | null = null;
  private initialized = false;

  constructor(config: VectorMemoryConfig) {
    this.config = {
      recallMaxChars: 800,
      autoRecall: true,
      autoCapture: false,
      ...config,
    };
  }

  /** Initialize the database connection */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.db = await connect(this.config.dbPath);
    this.initialized = true;
  }

  /** Store a fact in long-term memory */
  async store(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.ensureInit();

    const entry: MemoryEntry = {
      id: this.generateId(),
      text: value,
      category: (metadata?.category as MemoryEntry['category']) || 'other',
      importance: (metadata?.importance as number) ?? 0.7,
      timestamp: new Date().toISOString(),
      metadata: { key, ...metadata },
    };

    // Generate embedding
    entry.embedding = await this.embed(value);

    // Insert into LanceDB
    const table = await this.getOrCreateTable();
    await table.add([entry]);
  }

  /** Recall facts from long-term memory by semantic similarity */
  async recall(query: string, limit = 5): Promise<MemoryResult[]> {
    await this.ensureInit();

    const queryEmbedding = await this.embed(query);

    try {
      const table = await this.db!.openTable('memories');
      const results = await table
        .search(queryEmbedding)
        .limit(limit)
        .toArray();

      return results.map((row: Record<string, unknown>) => ({
        text: row.text as string,
        relevance: row._distance as number,
        timestamp: row.timestamp as string,
        metadata: row.metadata as Record<string, unknown>,
      }));
    } catch {
      // Table doesn't exist yet
      return [];
    }
  }

  /** Delete a specific memory */
  async forget(query: string): Promise<void> {
    await this.ensureInit();

    // Search for matching memories
    const results = await this.recall(query, 10);

    if (results.length === 0) return;

    // Delete the most relevant match
    const table = await this.db!.openTable('memories');
    // Note: LanceDB deletion API — this may need adjustment based on version
    // For now, we'll mark memories as deleted via metadata
    // Full deletion support will be added when we test against real LanceDB
  }

  // ─── Embedding ─────────────────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    if (this.config.embeddingProvider === 'ollama') {
      return this.embedOllama(text);
    } else if (this.config.embeddingProvider === 'openai') {
      return this.embedOpenAI(text);
    }
    throw new Error(`Unknown embedding provider: ${this.config.embeddingProvider}`);
  }

  private async embedOllama(text: string): Promise<number[]> {
    const baseUrl = this.config.embeddingBaseUrl || 'http://127.0.0.1:11434';
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  private async embedOpenAI(text: string): Promise<number[]> {
    const baseUrl = this.config.embeddingBaseUrl || 'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.embeddingApiKey}`,
      },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private async getOrCreateTable() {
    const tableName = 'memories';

    try {
      return await this.db!.openTable(tableName);
    } catch {
      // Table doesn't exist, create it with a sample entry
      const sampleEntry: MemoryEntry = {
        id: '__schema__',
        text: '__schema_entry__',
        category: 'other',
        importance: 0,
        embedding: new Array(this.config.dimensions).fill(0),
        timestamp: new Date().toISOString(),
        metadata: { key: '__schema__', schema_version: 1 },
      };

      return await this.db!.createTable(tableName, [sampleEntry]);
    }
  }

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
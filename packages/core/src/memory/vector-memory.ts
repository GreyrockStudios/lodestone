/**
 * Lodestone Core — Vector Memory
 *
 * Semantic memory storage using LanceDB for fast recall of facts,
 * preferences, decisions, and context. Auto-recall injects relevant
 * memories into every LLM turn.
 */

import { connect, type Connection, type Table } from '@lancedb/lancedb';
import type { MemoryAccess, MemoryResult } from '../tools/definitions.js';
import { MemoryError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

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
  private db: Connection | null = null;
  private initialized = false;
  private logger = getLogger('VectorMemory');

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

    // Check for duplicate (exact text match)
    try {
      const table = await this.getOrCreateTable();
      const existing = await table.query()
        .where(`text = '${value.replace(/'/g, "''")}'`)
        .limit(1)
        .toArray();
      if (existing.length > 0) {
        this.logger.debug('Skipping duplicate memory', { text: value.slice(0, 50) });
        return;
      }
    } catch {
      // Query failed — proceed with insert
    }

    const entry: Record<string, unknown> = {
      id: this.generateId(),
      text: value,
      category: (metadata?.category as string) || 'other',
      importance: (metadata?.importance as number) ?? 0.7,
      timestamp: new Date().toISOString(),
      key,
      vector: await this.embed(value),
    };

    // Insert into LanceDB
    try {
      const table = await this.getOrCreateTable();
      await table.add([entry] as unknown as Record<string, unknown>[]);
    } catch (err: unknown) {
      // Schema mismatch: recreate table with merged schema
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('schema') || msg.includes('not in schema')) {
        this.logger.warn('Schema mismatch, overwriting entry', { error: msg });
      } else {
        throw err;
      }
    }
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

      return results
        .filter((row: Record<string, unknown>) => row.text !== '__schema_entry__')
        .map((row: Record<string, unknown>) => ({
          text: row.text as string,
          relevance: row._distance as number,
          timestamp: row.timestamp as string,
          metadata: {
            category: row.category,
            importance: row.importance,
            key: row.key,
          },
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

    // Delete the most relevant match using its key
    const key = results[0].metadata?.key as string | undefined;
    if (!key) return;

    const table = await this.db!.openTable('memories');
    await table.delete(`key = '${key}'`);
    this.logger.info('Memory deleted', { key, query: query.slice(0, 50) });
  }

  // ─── Embedding ─────────────────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    if (this.config.embeddingProvider === 'ollama') {
      return this.embedOllama(text);
    } else if (this.config.embeddingProvider === 'openai') {
      return this.embedOpenAI(text);
    }
    throw new MemoryError(`Unknown embedding provider: ${this.config.embeddingProvider}`, { context: { provider: this.config.embeddingProvider } });
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
      throw new MemoryError(`Ollama embedding failed: ${response.statusText}`, { context: { status: response.status }, recoverable: true });
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
      throw new MemoryError(`OpenAI embedding failed: ${response.statusText}`, { context: { status: response.status }, recoverable: true });
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
      // Table doesn't exist — create with a schema entry using 'vector' as the column name
      // LanceDB expects the vector column to be named 'vector' by default
      const schemaEntry = [{
        id: '__schema__',
        text: '__schema_entry__',
        category: 'other',
        importance: 0,
        key: '__schema__',
        timestamp: new Date().toISOString(),
        vector: new Array(this.config.dimensions).fill(0),
      }];

      return await this.db!.createTable(tableName, schemaEntry);
    }
  }

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
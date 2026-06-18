/**
 * Lodestone Core — Memory System
 *
 * Unified interface to the three-layer memory system:
 * Wiki (curated knowledge), Vector (semantic recall), Scratch (session state).
 *
 * This is what tools interact with when they need memory access.
 */

import { WikiStore, type WikiSearchResult } from './wiki-store.js';
import { VectorMemory } from './vector-memory.js';
import { ScratchBuffer } from './scratch-buffer.js';
import { KnowledgeGraph, type KnowledgeGraphConfig } from './knowledge-graph.js';
import type { MemoryResult } from '../tools/definitions.js';
import { join } from 'path';

// ─── Config ─────────────────────────────────────────────────────────────────

export interface MemorySystemConfig {
  wiki: {
    rootDir: string;
    autoIndex: boolean;
    autoLint: boolean;
    categories: string[];
  };
  vector: {
    dbPath: string;
    embeddingProvider: 'ollama' | 'openai';
    embeddingModel: string;
    dimensions: number;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
    autoRecall: boolean;
    autoCapture: boolean;
    recallMaxChars: number;
  };
  scratch: {
    dbPath: string;
    defaultTtlMs: number | null;
  };
  /** Knowledge graph config (optional — uses memoryDir by default) */
  knowledgeGraph?: {
    dataDir: string;
    maxNodes?: number;
    maxEdgesPerNode?: number;
  };
}

// ─── Memory System ───────────────────────────────────────────────────────────

export class MemorySystem {
  readonly wiki: WikiStore;
  readonly vector: VectorMemory;
  readonly scratch: ScratchBuffer;
  readonly knowledgeGraph: KnowledgeGraph;

  private config: MemorySystemConfig;

  constructor(config: MemorySystemConfig) {
    this.config = config;

    this.wiki = new WikiStore({
      rootDir: config.wiki.rootDir,
      autoIndex: config.wiki.autoIndex,
      autoLint: config.wiki.autoLint,
      categories: config.wiki.categories,
    });

    this.vector = new VectorMemory({
      dbPath: config.vector.dbPath,
      embeddingProvider: config.vector.embeddingProvider,
      embeddingModel: config.vector.embeddingModel,
      dimensions: config.vector.dimensions,
      embeddingBaseUrl: config.vector.embeddingBaseUrl,
      embeddingApiKey: config.vector.embeddingApiKey,
      recallMaxChars: config.vector.recallMaxChars,
      autoRecall: config.vector.autoRecall,
      autoCapture: config.vector.autoCapture,
    });

    this.scratch = new ScratchBuffer({
      dbPath: config.scratch.dbPath,
      defaultTtlMs: config.scratch.defaultTtlMs,
    });

    this.knowledgeGraph = new KnowledgeGraph({
      dataDir: config.knowledgeGraph?.dataDir || join(config.vector.dbPath, '..', 'knowledge-graph'),
      maxNodes: config.knowledgeGraph?.maxNodes,
      maxEdgesPerNode: config.knowledgeGraph?.maxEdgesPerNode,
    });
  }

  /** Initialize all memory subsystems */
  async init(): Promise<void> {
    await Promise.all([
      this.vector.init(),
      this.scratch.init(),
      this.knowledgeGraph.init(),
      // Wiki loads lazily on first access
    ]);
  }

  // ─── Convenience Methods ───────────────────────────────────────────────

  /** Smart retrieve: search wiki + vector memory, ranked by relevance */
  async smartRetrieve(query: string, limit = 5): Promise<{
    wiki: WikiSearchResult[];
    memories: MemoryResult[];
  }> {
    const [wiki, memories] = await Promise.all([
      this.wiki.search(query, limit),
      this.vector.recall(query, limit),
    ]);

    return { wiki, memories };
  }

  /** Store a fact in vector memory */
  async storeFact(text: string, category: MemoryResult['metadata'] extends Record<string, unknown> ? never : string, importance = 0.7): Promise<void> {
    await this.vector.store(`fact_${Date.now()}`, text, {
      category: category || 'fact',
      importance,
    });
  }

  /** Get or create a wiki page */
  async ensureWikiPage(slug: string, title: string, content: string): Promise<void> {
    const existing = await this.wiki.read(slug);
    if (!existing) {
      await this.wiki.write(slug, content, { title, status: 'active' });
    }
  }

  /** Save session state to scratch buffer for context compaction survival */
  async saveSessionState(state: {
    currentTask: string;
    progress: string;
    blockedBy?: string;
    nextSteps: string[];
    recentFiles: string[];
    openQuestions?: string[];
    mood?: string;
  }): Promise<void> {
    await this.scratch.scratchSet('session-state', JSON.stringify(state));
    await this.scratch.scratchSet('session-state-timestamp', new Date().toISOString());
  }

  /** Load session state from scratch buffer */
  async loadSessionState(): Promise<{
    currentTask: string;
    progress: string;
    blockedBy?: string;
    nextSteps: string[];
    recentFiles: string[];
    openQuestions?: string[];
    mood?: string;
  } | null> {
    const raw = await this.scratch.scratchGet('session-state');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Rebuild the wiki index */
  async rebuildWikiIndex(): Promise<void> {
    await this.wiki.rebuildIndex();
  }
}
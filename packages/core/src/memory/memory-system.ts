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
import { MemoryCompounding, type CompoundingConfig, type CompoundingReport } from './memory-compounding.js';
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
  /** Memory compounding config (optional — enables auto entity extraction + contradiction detection) */
  compounding?: {
    dataDir: string;
    enabled?: boolean;
  };
}

// ─── Memory System ───────────────────────────────────────────────────────────

export class MemorySystem {
  readonly wiki: WikiStore;
  readonly vector: VectorMemory;
  readonly scratch: ScratchBuffer;
  readonly knowledgeGraph: KnowledgeGraph;
  readonly compounding: MemoryCompounding | null;

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

    // Memory compounding (optional — enables auto entity extraction, contradiction detection)
    const compoundingEnabled = config.compounding?.enabled !== false;
    this.compounding = compoundingEnabled
      ? new MemoryCompounding({
          dataDir: config.compounding?.dataDir || join(config.vector.dbPath, '..', 'compounding'),
          wikiRoot: config.wiki.rootDir,
        })
      : null;

    // Wire compounding into wiki writes — every wiki.write() triggers entity extraction
    if (this.compounding) {
      this.wiki.onWriteEvent((slug, content) => { void this.processWikiWrite(slug, content); });
    }
  }

  /** Initialize all memory subsystems */
  async init(): Promise<void> {
    const initPromises: Promise<void>[] = [
      this.vector.init(),
      this.scratch.init(),
      this.knowledgeGraph.init(),
      // Wiki loads lazily on first access
    ];
    if (this.compounding) {
      initPromises.push(this.compounding.init().then(() => undefined));
    }
    await Promise.all(initPromises);
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
      // Compounding hook fires automatically via WikiStore.onWriteEvent
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

  // ─── Memory Compounding ────────────────────────────────────────────────

  /**
   * Process a wiki page write through the compounding pipeline.
   * Extracts entities, checks for contradictions, and adds entities
   * to the knowledge graph automatically.
   *
   * Called after every wiki write. No-op if compounding is disabled.
   */
  async processWikiWrite(slug: string, content: string): Promise<CompoundingReport | null> {
    if (!this.compounding) return null;

    // Run compounding analysis (entity extraction + contradiction detection)
    const report = this.compounding.processWikiWrite(slug, content);

    // Feed extracted entities into the knowledge graph
    const entities = this.compounding.extractEntities(content);
    for (const entity of entities) {
      const nodeId = `${entity.type}:${entity.name.toLowerCase().replace(/\s+/g, '-')}`;
      const existing = this.knowledgeGraph.getNode(nodeId);

      if (!existing) {
        await this.knowledgeGraph.addNode({
          id: nodeId,
          label: entity.name,
          type: entity.type === 'project' ? 'project' : entity.type === 'tool' ? 'tool' : entity.type === 'concept' ? 'concept' : 'entity',
          wikiSlug: slug,
          state: {},
          tags: [entity.type, `from:${slug}`],
        });
      } else {
        // Node exists — add a tag noting it was mentioned in this page
        const newTags = Array.from(new Set([...(existing.tags || []), `from:${slug}`]));
        await this.knowledgeGraph.addNode({
          id: nodeId,
          label: existing.label,
          type: existing.type,
          wikiSlug: existing.wikiSlug,
          state: existing.state,
          tags: newTags,
        });
      }
    }

    // Add edges between entities mentioned in the same page (co-occurrence)
    const contentLower = content.toLowerCase();
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i];
        const b = entities[j];
        const idA = `${a.type}:${a.name.toLowerCase().replace(/\s+/g, '-')}`;
        const idB = `${b.type}:${b.name.toLowerCase().replace(/\s+/g, '-')}`;

        // Check both nodes exist in the graph
        if (this.knowledgeGraph.getNode(idA) && this.knowledgeGraph.getNode(idB)) {
          // Check they co-occur within 200 chars in the content
          const idxA = contentLower.indexOf(a.name.toLowerCase());
          const idxB = contentLower.indexOf(b.name.toLowerCase());
          if (idxA >= 0 && idxB >= 0 && Math.abs(idxA - idxB) < 200) {
            try {
              await this.knowledgeGraph.addEdge({
                from: idA,
                to: idB,
                type: 'related-to',
                description: `Co-mentioned in [[${slug}]]`,
                validFrom: new Date().toISOString(),
              });
            } catch {
              // Edge already exists or node missing — skip
            }
          }
        }
      }
    }

    return report;
  }

  /** Get compounding stats for dashboard */
  getCompoundingStats(): { enabled: boolean; contradictions: number; growthReport: ReturnType<MemoryCompounding['generateGrowthReport']> | null } {
    if (!this.compounding) {
      return { enabled: false, contradictions: 0, growthReport: null };
    }
    return {
      enabled: true,
      contradictions: this.compounding.getContradictions().length,
      growthReport: this.compounding.generateGrowthReport(),
    };
  }
}
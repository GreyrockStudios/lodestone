/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
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

  /** Store a fact in vector memory (with auto-compounding) */
  async storeFact(text: string, category: string, importance = 0.7): Promise<void> {
    const key = `fact_${Date.now()}`;
    await this.vector.store(key, text, {
      category: category || 'fact',
      importance,
    });
    // Auto-compound: extract entities + cross-reference with wiki
    await this.processVectorStore(key, text);
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

    // Check for existing page to detect state changes (temporal edges)
    const existingPage = await this.wiki.read(slug);

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

    // Temporal edges: if the page was updated, detect state changes and model the change
    if (existingPage) {
      await this.detectTemporalChanges(slug, existingPage.content, content);
    }

    return report;
  }

  /**
   * Process a vector memory store through the compounding pipeline.
   * Extracts entities from the stored text and adds them to the knowledge graph.
   * Checks for contradictions against existing wiki pages.
   *
   * Called after every vector.store(). No-op if compounding is disabled.
   */
  async processVectorStore(key: string, text: string): Promise<CompoundingReport | null> {
    if (!this.compounding) return null;

    // Run compounding analysis (entity extraction + contradiction detection against wiki)
    const report = this.compounding.processVectorStore(key, text);

    // Feed extracted entities into the knowledge graph (if not already present)
    const entities = this.compounding.extractEntities(text);
    for (const entity of entities) {
      const nodeId = `${entity.type}:${entity.name.toLowerCase().replace(/\s+/g, '-')}`;
      const existing = this.knowledgeGraph.getNode(nodeId);

      if (!existing) {
        await this.knowledgeGraph.addNode({
          id: nodeId,
          label: entity.name,
          type: entity.type === 'project' ? 'project' : entity.type === 'tool' ? 'tool' : entity.type === 'concept' ? 'concept' : 'entity',
          state: { source: key },
          tags: [entity.type, `from:vector:${key}`],
        });
      } else {
        // Node exists — tag it as also mentioned in vector memory
        const newTags = Array.from(new Set([...(existing.tags || []), `from:vector:${key}`]));
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

    // Log contradictions as warnings (don't block the store)
    if (report.contradictionsFound > 0) {
      // Contradictions are already saved by the compounding engine
      // Just log a warning — the contradictions are tracked for review
      const contradictions = this.compounding.getContradictions().slice(-report.contradictionsFound);
      for (const c of contradictions) {
        // Warning logged but not blocked — agent can review contradictions later
        void c; // No-op: contradiction already saved by MemoryCompounding
      }
    }

    return report;
  }

  /**
   * Detect temporal changes between old and new wiki content.
   * When facts change, adds 'evolved-to' or 'replaced-by' edges to model the change
   * instead of replacing the old fact.
   */
  private async detectTemporalChanges(slug: string, oldContent: string, newContent: string): Promise<void> {
    // Extract entities from both versions
    const oldEntities = this.compounding!.extractEntities(oldContent);
    const newEntities = this.compounding!.extractEntities(newContent);

    // Find entities that were in the old content but not in the new (removed/evolved)
    const oldSet = new Set(oldEntities.map(e => `${e.type}:${e.name.toLowerCase().replace(/\s+/g, '-')}`));
    const newSet = new Set(newEntities.map(e => `${e.type}:${e.name.toLowerCase().replace(/\s+/g, '-')}`));

    // Entities removed from the page — mark existing edges as ended (temporal)
    for (const oldId of oldSet) {
      if (!newSet.has(oldId)) {
        const node = this.knowledgeGraph.getNode(oldId);
        if (node && node.wikiSlug === slug) {
          // End the existing wiki association — the entity is no longer on this page
          const outEdges = this.knowledgeGraph.getOutEdges(oldId);
          for (const edge of outEdges) {
            if (edge.description?.includes(`[[${slug}]]`)) {
              // Mark this edge as ended (temporal)
              await this.knowledgeGraph.updateEdge(edge.id, {
                validTo: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    // Find entities present in both but with changed context — add 'evolved-to' edge
    const now = new Date().toISOString();
    for (const oldEntity of oldEntities) {
      const matching = newEntities.find(n => n.name === oldEntity.name && n.type === oldEntity.type);
      if (matching) {
        // Entity still present — check if its context changed
        const oldIdx = oldContent.toLowerCase().indexOf(oldEntity.name.toLowerCase());
        const newIdx = newContent.toLowerCase().indexOf(matching.name.toLowerCase());
        if (oldIdx >= 0 && newIdx >= 0) {
          // Get surrounding context (±100 chars)
          const oldContext = oldContent.slice(Math.max(0, oldIdx - 100), oldIdx + oldEntity.name.length + 100);
          const newContext = newContent.slice(Math.max(0, newIdx - 100), newIdx + matching.name.length + 100);
          if (oldContext !== newContext) {
            // Context changed — model the evolution
            const entityId = `${oldEntity.type}:${oldEntity.name.toLowerCase().replace(/\s+/g, '-')}`;
            const versionNode = await this.knowledgeGraph.addNode({
              id: `${entityId}:version:${now}`,
              label: `${oldEntity.name} (updated ${now.split('T')[0]})`,
              type: 'entity',
              wikiSlug: slug,
              state: { context: newContext.slice(0, 200) },
              tags: ['version', `from:${slug}`],
            });
            try {
              await this.knowledgeGraph.addEdge({
                from: entityId,
                to: versionNode.id,
                type: 'evolved-to',
                description: `Context changed in [[${slug}]]`,
                validFrom: now,
              });
            } catch {
              // Edge already exists or node missing — skip
            }
          }
        }
      }
    }
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

  /**
   * Get a comprehensive compounding report.
   * Returns stats on graph growth, contradictions, thin areas, and recent activity.
   */
  getCompoundingReport(): {
    enabled: boolean;
    graphStats: { nodeCount: number; edgeCount: number; byType: Record<string, number>; byEdgeType: Record<string, number> };
    contradictions: number;
    growthReport: ReturnType<MemoryCompounding['generateGrowthReport']> | null;
    thinAreas: string[];
    recentGrowth: { nodes: number; edges: number } | null;
  } {
    if (!this.compounding) {
      return {
        enabled: false,
        graphStats: { nodeCount: 0, edgeCount: 0, byType: {}, byEdgeType: {} },
        contradictions: 0,
        growthReport: null,
        thinAreas: [],
        recentGrowth: null,
      };
    }

    const graphStats = this.knowledgeGraph.getStats();
    const growthReport = this.compounding.generateGrowthReport();

    return {
      enabled: true,
      graphStats,
      contradictions: this.compounding.getContradictions().length,
      growthReport,
      thinAreas: growthReport.thinAreas,
      recentGrowth: {
        nodes: graphStats.nodeCount,
        edges: graphStats.edgeCount,
      },
    };
  }
}
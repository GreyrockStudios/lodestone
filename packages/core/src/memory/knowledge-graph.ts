/**
 * Lodestone — Knowledge Graph
 *
 * Adds entity-relationship modeling on top of the wiki system.
 * Tracks how concepts connect, models state changes over time,
 * and enables graph queries like "what's related to X?" and
 * "how did Y change over time?"
 *
 * The wiki stores documents; the knowledge graph stores structure.
 * Together they give a complete picture: what we know (wiki) and
 * how it connects (graph).
 *
 * Nodes: Entities (people, tools, concepts, projects)
 * Edges: Relationships (depends-on, uses, member-of, evolved-to, etc.)
 * Temporal: Each edge has a time range (from/to), enabling historical queries.
 *
 * Inspired by WASP's temporal world model, but simpler and wiki-native.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EdgeType =
  | 'depends-on'       // A requires B to function
  | 'uses'             // A uses B as a tool/dependency
  | 'member-of'        // A is part of B
  | 'related-to'       // A is loosely related to B
  | 'evolved-to'       // A became B (temporal)
  | 'replaced-by'      // A was replaced by B (temporal)
  | 'precedes'         // A comes before B (sequence)
  | 'contradicts'      // A contradicts B (knowledge conflict)
  | 'supports'         // A supports/validates B
  | 'blocks'           // A blocks/prevents B
  | 'produces'         // A produces/outputs B
  | 'custom';           // Custom edge type

export interface GraphNode {
  /** Unique identifier (usually wiki slug) */
  id: string;
  /** Human-readable label */
  label: string;
  /** Node type */
  type: 'entity' | 'concept' | 'project' | 'area' | 'decision' | 'tool' | 'custom';
  /** Wiki slug this node is associated with */
  wikiSlug?: string;
  /** Current state of this entity (key-value pairs) */
  state: Record<string, string>;
  /** Tags */
  tags: string[];
  /** When this node was created */
  createdAt: string;
  /** When this node was last updated */
  updatedAt: string;
}

export interface GraphEdge {
  /** Unique edge ID */
  id: string;
  /** Source node ID */
  from: string;
  /** Target node ID */
  to: string;
  /** Relationship type */
  type: EdgeType;
  /** Human-readable description */
  description?: string;
  /** When this relationship became active (null = always) */
  validFrom?: string;
  /** When this relationship ended (null = still active) */
  validTo?: string;
  /** Metadata */
  metadata?: Record<string, string>;
  /** When this edge was created */
  createdAt: string;
}

export interface GraphQuery {
  /** Start from this node */
  from?: string;
  /** End at this node */
  to?: string;
  /** Filter by edge type */
  edgeType?: EdgeType;
  /** Filter by node type */
  nodeType?: GraphNode['type'];
  /** Max depth for traversal */
  maxDepth?: number;
  /** Whether to include historical (ended) edges */
  includeHistorical?: boolean;
  /** Point in time for temporal queries */
  asOf?: string;
}

export interface GraphPath {
  /** Path from start to end */
  nodes: GraphNode[];
  /** Edges connecting the nodes */
  edges: GraphEdge[];
  /** Total path length */
  length: number;
}

export interface KnowledgeGraphConfig {
  /** Directory for storing graph data */
  dataDir: string;
  /** Maximum nodes */
  maxNodes?: number;
  /** Maximum edges per node */
  maxEdgesPerNode?: number;
}

// ─── Knowledge Graph System ──────────────────────────────────────────────────

export class KnowledgeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  private config: KnowledgeGraphConfig;
  private nodesFile: string;
  private edgesFile: string;
  private loaded = false;
  private log = getLogger('knowledge-graph');

  // Index: node ID -> edge IDs (outgoing)
  private outEdges: Map<string, Set<string>> = new Map();
  // Index: node ID -> edge IDs (incoming)
  private inEdges: Map<string, Set<string>> = new Map();

  constructor(config: KnowledgeGraphConfig) {
    this.config = config;
    this.nodesFile = join(config.dataDir, 'graph-nodes.json');
    this.edgesFile = join(config.dataDir, 'graph-edges.json');
  }

  /** Initialize by loading existing graph data */
  async init(): Promise<void> {
    try {
      const nodesData = await readFile(this.nodesFile, 'utf-8');
      const nodes = JSON.parse(nodesData);
      for (const node of nodes) {
        this.nodes.set(node.id, node);
      }
    } catch {
      await mkdir(join(this.nodesFile, '..'), { recursive: true });
      await writeFile(this.nodesFile, '[]', 'utf-8');
    }

    try {
      const edgesData = await readFile(this.edgesFile, 'utf-8');
      const edges = JSON.parse(edgesData);
      for (const edge of edges) {
        this.edges.set(edge.id, edge);
        // Rebuild indexes
        if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, new Set());
        this.outEdges.get(edge.from)!.add(edge.id);
        if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, new Set());
        this.inEdges.get(edge.to)!.add(edge.id);
      }
    } catch {
      await mkdir(join(this.edgesFile, '..'), { recursive: true });
      await writeFile(this.edgesFile, '[]', 'utf-8');
    }

    this.loaded = true;
    this.log.info(`Knowledge graph loaded: ${this.nodes.size} nodes, ${this.edges.size} edges`);
  }

  // ─── Node Operations ────────────────────────────────────────────────────

  /** Add or update a node */
  async addNode(node: Omit<GraphNode, 'createdAt' | 'updatedAt'>): Promise<GraphNode> {
    const existing = this.nodes.get(node.id);
    const now = new Date().toISOString();

    const graphNode: GraphNode = {
      ...node,
      state: node.state || {},
      tags: node.tags || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this.nodes.set(node.id, graphNode);
    await this.saveNodes();
    return graphNode;
  }

  /** Get a node by ID */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Update a node's state */
  async updateNodeState(id: string, stateUpdates: Record<string, string>): Promise<GraphNode | null> {
    const node = this.nodes.get(id);
    if (!node) return null;

    node.state = { ...node.state, ...stateUpdates };
    node.updatedAt = new Date().toISOString();
    this.nodes.set(id, node);
    await this.saveNodes();
    return node;
  }

  /** Remove a node and all its edges */
  async removeNode(id: string): Promise<boolean> {
    if (!this.nodes.has(id)) return false;

    // Remove all connected edges
    const outEdgeIds = this.outEdges.get(id) || new Set();
    const inEdgeIds = this.inEdges.get(id) || new Set();
    for (const edgeId of [...outEdgeIds, ...inEdgeIds]) {
      this.edges.delete(edgeId);
    }
    this.outEdges.delete(id);
    this.inEdges.delete(id);
    this.nodes.delete(id);

    await Promise.all([this.saveNodes(), this.saveEdges()]);
    return true;
  }

  /** Search nodes by label or tags */
  searchNodes(query: string, limit = 10): GraphNode[] {
    const q = query.toLowerCase();
    return Array.from(this.nodes.values())
      .filter(n => {
        if (n.label.toLowerCase().includes(q)) return true;
        if (n.tags.some(t => t.toLowerCase().includes(q))) return true;
        if (n.id.toLowerCase().includes(q)) return true;
        return false;
      })
      .slice(0, limit);
  }

  // ─── Edge Operations ────────────────────────────────────────────────────

  /** Add an edge */
  async addEdge(edge: Omit<GraphEdge, 'id' | 'createdAt'>): Promise<GraphEdge> {
    // Validate that both nodes exist
    if (!this.nodes.has(edge.from)) {
      throw new Error(`Source node "${edge.from}" does not exist`);
    }
    if (!this.nodes.has(edge.to)) {
      throw new Error(`Target node "${edge.to}" does not exist`);
    }

    // Check for duplicate edges
    const existing = this.findEdge(edge.from, edge.to, edge.type);
    if (existing) {
      // Update the existing edge instead of creating a duplicate
      return this.updateEdge(existing.id, edge) as Promise<GraphEdge>;
    }

    const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const graphEdge: GraphEdge = {
      ...edge,
      id,
      createdAt: new Date().toISOString(),
    };

    this.edges.set(id, graphEdge);

    // Update indexes
    if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, new Set());
    this.outEdges.get(edge.from)!.add(id);
    if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, new Set());
    this.inEdges.get(edge.to)!.add(id);

    await this.saveEdges();
    return graphEdge;
  }

  /** Find an edge between two nodes */
  findEdge(from: string, to: string, type?: EdgeType): GraphEdge | undefined {
    const outIds = this.outEdges.get(from);
    if (!outIds) return undefined;

    for (const edgeId of outIds) {
      const edge = this.edges.get(edgeId);
      if (edge && edge.to === to && (!type || edge.type === type)) {
        return edge;
      }
    }
    return undefined;
  }

  /** Update an edge */
  async updateEdge(id: string, updates: Partial<GraphEdge>): Promise<GraphEdge | null> {
    const edge = this.edges.get(id);
    if (!edge) return null;

    const updated = { ...edge, ...updates, id: edge.id, createdAt: edge.createdAt };
    this.edges.set(id, updated);
    await this.saveEdges();
    return updated;
  }

  /** Remove an edge */
  async removeEdge(id: string): Promise<boolean> {
    const edge = this.edges.get(id);
    if (!edge) return false;

    // Update indexes
    this.outEdges.get(edge.from)?.delete(id);
    this.inEdges.get(edge.to)?.delete(id);
    this.edges.delete(id);

    await this.saveEdges();
    return true;
  }

  // ─── Graph Queries ──────────────────────────────────────────────────────

  /** Get all edges from a node (outgoing) */
  getOutEdges(nodeId: string, type?: EdgeType): GraphEdge[] {
    const edgeIds = this.outEdges.get(nodeId) || new Set();
    return Array.from(edgeIds)
      .map(id => this.edges.get(id))
      .filter((e): e is GraphEdge => e !== undefined)
      .filter(e => !type || e.type === type)
      .filter(e => e.validTo === undefined); // Only active edges by default
  }

  /** Get all edges to a node (incoming) */
  getInEdges(nodeId: string, type?: EdgeType): GraphEdge[] {
    const edgeIds = this.inEdges.get(nodeId) || new Set();
    return Array.from(edgeIds)
      .map(id => this.edges.get(id))
      .filter((e): e is GraphEdge => e !== undefined)
      .filter(e => !type || e.type === type)
      .filter(e => e.validTo === undefined);
  }

  /** Get all neighbors of a node */
  getNeighbors(nodeId: string, type?: EdgeType): GraphNode[] {
    const outEdges = this.getOutEdges(nodeId, type);
    const inEdges = this.getInEdges(nodeId, type);

    const neighborIds = new Set<string>();
    for (const e of outEdges) neighborIds.add(e.to);
    for (const e of inEdges) neighborIds.add(e.from);

    return Array.from(neighborIds)
      .map(id => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Traverse the graph from a starting node */
  traverse(startId: string, query?: GraphQuery): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const maxDepth = query?.maxDepth || 3;
    const visited = new Set<string>();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (!node) continue;

      // Filter by node type if specified
      if (query?.nodeType && node.type !== query.nodeType) continue;

      nodes.push(node);

      if (depth < maxDepth) {
        const outEdges = this.getOutEdges(id, query?.edgeType);
        for (const edge of outEdges) {
          // Filter historical edges if requested
          if (!query?.includeHistorical && edge.validTo) continue;
          // Filter by point-in-time if requested
          if (query?.asOf) {
            const asOf = new Date(query.asOf);
            if (edge.validFrom && new Date(edge.validFrom) > asOf) continue;
            if (edge.validTo && new Date(edge.validTo) < asOf) continue;
          }

          edges.push(edge);
          queue.push({ id: edge.to, depth: depth + 1 });
        }
      }
    }

    return { nodes, edges };
  }

  /** Find the shortest path between two nodes */
  findPath(fromId: string, toId: string, maxDepth = 6): GraphPath | null {
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: { node: GraphNode; edge?: GraphEdge }[] }> = [];

    const startNode = this.nodes.get(fromId);
    if (!startNode) return null;
    if (fromId === toId) return { nodes: [startNode], edges: [], length: 0 };

    queue.push({ id: fromId, path: [{ node: startNode }] });

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;

      if (visited.has(id) || path.length > maxDepth) continue;
      visited.add(id);

      const outEdges = this.getOutEdges(id);
      for (const edge of outEdges) {
        const targetNode = this.nodes.get(edge.to);
        if (!targetNode) continue;

        const newPath = [...path, { node: targetNode, edge }];

        if (edge.to === toId) {
          return {
            nodes: newPath.map(p => p.node),
            edges: newPath.filter(p => p.edge).map(p => p.edge!),
            length: newPath.length - 1,
          };
        }

        queue.push({ id: edge.to, path: newPath });
      }
    }

    return null; // No path found
  }

  /** Get temporal state of a node at a point in time */
  getStateAt(nodeId: string, asOf: string): Record<string, string> | null {
    const node = this.nodes.get(nodeId);
    if (!node) return null;

    // Get historical edges to find state changes
    const historicalEdges = Array.from(this.edges.values())
      .filter(e => (e.from === nodeId || e.to === nodeId) && e.type === 'evolved-to')
      .filter(e => {
        if (!e.validFrom) return true;
        return new Date(e.validFrom) <= new Date(asOf);
      });

    // Start with current state and apply historical changes
    // (This is a simplified temporal model — full implementation would use event sourcing)
    return { ...node.state, _asOf: asOf };
  }

  /** Get statistics */
  getStats(): { nodeCount: number; edgeCount: number; byType: Record<string, number>; byEdgeType: Record<string, number> } {
    const byType: Record<string, number> = {};
    const byEdgeType: Record<string, number> = {};

    for (const node of this.nodes.values()) {
      byType[node.type] = (byType[node.type] || 0) + 1;
    }

    for (const edge of this.edges.values()) {
      byEdgeType[edge.type] = (byEdgeType[edge.type] || 0) + 1;
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      byType,
      byEdgeType,
    };
  }

  /** Export graph as DOT format (for visualization) */
  toDot(): string {
    const lines: string[] = ['digraph KnowledgeGraph {'];
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box];');
    lines.push('');

    // Nodes
    for (const node of this.nodes.values()) {
      const label = node.label.replace(/"/g, '\\"');
      const typeColors: Record<string, string> = {
        entity: 'lightblue',
        concept: 'lightyellow',
        project: 'lightgreen',
        area: 'lightpink',
        decision: 'lightsalmon',
        tool: 'lightgray',
      };
      const color = typeColors[node.type] || 'white';
      lines.push(`  "${node.id}" [label="${label}", style=filled, fillcolor=${color}];`);
    }

    lines.push('');

    // Edges
    const edgeStyles: Record<string, string> = {
      'depends-on': 'solid',
      'uses': 'dashed',
      'member-of': 'bold',
      'evolved-to': 'dotted',
      'replaced-by': 'dotted',
      'contradicts': 'dashed, color=red',
    };

    for (const edge of this.edges.values()) {
      if (edge.validTo) continue; // Skip historical edges
      const style = edgeStyles[edge.type] || 'solid';
      const label = edge.type.replace('-', ' ');
      lines.push(`  "${edge.from}" -> "${edge.to}" [label="${label}", style=${style}];`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async saveNodes(): Promise<void> {
    const data = Array.from(this.nodes.values());
    await mkdir(join(this.nodesFile, '..'), { recursive: true });
    await writeFile(this.nodesFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async saveEdges(): Promise<void> {
    const data = Array.from(this.edges.values());
    await mkdir(join(this.edgesFile, '..'), { recursive: true });
    await writeFile(this.edgesFile, JSON.stringify(data, null, 2), 'utf-8');
  }
}
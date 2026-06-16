/**
 * Lodestone — Decision Log Tool
 *
 * Records decisions with rationale. Prevents re-litigating settled topics
 * across sessions. Searchable, supersedeable, persistent.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface DecisionEntry {
  id: string;
  decision: string;
  rationale: string;
  context?: string;
  tags?: string[];
  decidedBy?: string;
  createdAt: string;
  supersededBy?: string;
  supersededAt?: string;
}

const definition: ToolDefinition = {
  id: 'decision-log',
  name: 'Decision Log',
  description: 'Record a decision with rationale, or search/list previous decisions. Prevents re-litigating settled topics.',
  parameters: [
    { name: 'action', description: 'add, get, list, search, or supersede', type: 'string', required: true },
    { name: 'decision', description: 'What was decided (one sentence)', type: 'string', required: false },
    { name: 'rationale', description: 'Why this was chosen', type: 'string', required: false },
    { name: 'context', description: 'What triggered this decision', type: 'string', required: false },
    { name: 'tags', description: 'Tags for categorization', type: 'array', required: false, items: { name: 'tag', description: 'A tag', type: 'string', required: false } },
    { name: 'id', description: 'Decision ID for get/supersede', type: 'string', required: false },
    { name: 'query', description: 'Search query for search action', type: 'string', required: false },
    { name: 'oldId', description: 'ID of the old decision being superseded', type: 'string', required: false },
    { name: 'newId', description: 'ID of the new decision that replaces it', type: 'string', required: false },
    { name: 'limit', description: 'Max results for list/search', type: 'number', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class DecisionLogTool implements Tool {
  readonly definition = definition;
  private decisions: Map<string, DecisionEntry> = new Map();
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'add': return await this.add(params, context);
        case 'get': return await this.get(params);
        case 'list': return await this.list(params);
        case 'search': return await this.search(params);
        case 'supersede': return await this.supersede(params);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: `Valid actions are: add, get, list, search, supersede`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: 'Decision log error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  private async add(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const id = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const entry: DecisionEntry = {
      id,
      decision: params.decision as string,
      rationale: params.rationale as string,
      context: params.context as string | undefined,
      tags: params.tags as string[] || [],
      decidedBy: context.identity.name,
      createdAt: new Date().toISOString(),
    };

    this.decisions.set(id, entry);

    // Also store in wiki decisions directory
    if (context.memory) {
      const content = `# ${entry.decision}\n\n**Rationale:** ${entry.rationale}\n\n${entry.context ? `**Context:** ${entry.context}\n\n` : ''}**Decided by:** ${entry.decidedBy}\n**Date:** ${entry.createdAt}\n${entry.tags?.length ? `**Tags:** ${entry.tags.join(', ')}\n` : ''}`;
      await context.memory.wikiWrite(`decisions/${entry.createdAt.split('T')[0]}-${id}`, content, {
        title: entry.decision,
        tags: entry.tags,
        agents: [context.identity.name],
      }).catch(() => {}); // Non-fatal if wiki write fails
    }

    return {
      success: true,
      data: entry,
      summary: `Decision #${id} recorded: ${entry.decision}`,
      durationMs: 0, // Will be set by registry
      includeInContext: false,
    };
  }

  private async get(params: Record<string, unknown>): Promise<ToolResult> {
    const id = params.id as string;
    const entry = this.decisions.get(id);

    if (!entry) {
      return {
        success: false,
        data: null,
        summary: `Decision ${id} not found`,
        error: 'Not found',
        durationMs: 0,
        includeInContext: true,
      };
    }

    return {
      success: true,
      data: entry,
      summary: `Decision #${id}: ${entry.decision}`,
      durationMs: 0,
      includeInContext: true,
    };
  }

  private async list(params: Record<string, unknown>): Promise<ToolResult> {
    const limit = (params.limit as number) || 10;
    const entries = Array.from(this.decisions.values())
      .filter(d => !d.supersededBy) // Only active decisions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    return {
      success: true,
      data: entries,
      summary: `${entries.length} active decisions`,
      durationMs: 0,
      includeInContext: true,
    };
  }

  private async search(params: Record<string, unknown>): Promise<ToolResult> {
    const query = (params.query as string).toLowerCase();
    const limit = (params.limit as number) || 5;

    const results = Array.from(this.decisions.values())
      .filter(d => {
        const searchable = `${d.decision} ${d.rationale} ${(d.tags || []).join(' ')} ${d.context || ''}`.toLowerCase();
        return searchable.includes(query);
      })
      .filter(d => !d.supersededBy)
      .slice(0, limit);

    return {
      success: true,
      data: results,
      summary: `${results.length} decisions matching "${query}"`,
      durationMs: 0,
      includeInContext: true,
    };
  }

  private async supersede(params: Record<string, unknown>): Promise<ToolResult> {
    const oldId = params.oldId as string;
    const newId = params.newId as string;

    const oldEntry = this.decisions.get(oldId);
    if (!oldEntry) {
      return {
        success: false,
        data: null,
        summary: `Decision ${oldId} not found`,
        error: 'Old decision not found',
        durationMs: 0,
        includeInContext: true,
      };
    }

    oldEntry.supersededBy = newId;
    oldEntry.supersededAt = new Date().toISOString();

    return {
      success: true,
      data: oldEntry,
      summary: `Decision #${oldId} superseded by #${newId}`,
      durationMs: 0,
      includeInContext: true,
    };
  }
}
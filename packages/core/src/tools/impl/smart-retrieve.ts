/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Smart Retrieve Tool
 *
 * Gets wiki pages ranked by relevance to current task.
 * Weighs recency, frequency, and project context.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

const definition: ToolDefinition = {
  id: 'smart-retrieve',
  name: 'Smart Retrieve',
  description: 'Get wiki pages ranked by relevance to current task. Weighs recency, frequency, and project context.',
  parameters: [
    { name: 'query', description: 'What you are looking for', type: 'string', required: true },
    { name: 'project', description: 'Current project name (boosts related pages)', type: 'string', required: false },
    { name: 'limit', description: 'Max results (default 5)', type: 'number', required: false },
  ],
  sideEffects: false,
  requiresApproval: false,
  timeout: 15000,
};

export class SmartRetrieveTool implements Tool {
  readonly definition = definition;

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;
    const project = params.project as string | undefined;
    const limit = (params.limit as number) || 5;
    const start = Date.now();

    try {
      // Delegate to memory system's smart retrieve
      const results = await context.memory.wikiSearch(query, limit * 2); // Get extra for ranking

      // Re-rank with project boost
      let ranked = results;
      if (project) {
        ranked = results.map(r => ({
          ...r,
          score: r.score + (r.slug.toLowerCase().includes(project.toLowerCase()) ? 5 : 0),
        })).sort((a, b) => b.score - a.score);
      }

      // Also get vector memory results
      const memories = await context.memory.recall(query, limit);

      return {
        success: true,
        data: {
          wiki: ranked.slice(0, limit),
          memories: memories.slice(0, limit),
          totalResults: ranked.length + memories.length,
        },
        summary: `Found ${ranked.length} wiki pages and ${memories.length} memories for "${query}"`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Smart retrieve failed for "${query}"`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
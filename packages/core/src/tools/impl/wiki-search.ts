/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Wiki Search Tool
 *
 * Search wiki pages by title, slug, or tag.
 * Split from wiki-resolve.ts for single-responsibility per file.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

const searchDefinition: ToolDefinition = {
  id: 'wiki-search',
  name: 'Wiki Search',
  description: 'Search wiki pages by title, slug, or tag.',
  parameters: [
    { name: 'query', description: 'Search query', type: 'string', required: true },
    { name: 'limit', description: 'Max results', type: 'number', required: false },
  ],
  sideEffects: false,
  requiresApproval: false,
};

export class WikiSearchTool implements Tool {
  readonly definition = searchDefinition;

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;
    const limit = (params.limit as number) || 10;
    const start = Date.now();

    try {
      // Use wiki search (delegates to the WikiStore)
      const results = await context.memory.wikiSearch(query, limit);

      return {
        success: true,
        data: results,
        summary: `${results.length} wiki pages matching "${query}"`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Wiki search failed for "${query}"`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
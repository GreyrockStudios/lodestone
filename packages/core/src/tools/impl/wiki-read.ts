/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Wiki Read Tool — read a wiki page by slug
 */
import type { Tool, ToolContext, ToolDefinition, ToolParameter, ToolResult } from '../definitions.js';

export class WikiReadTool implements Tool {
  definition: ToolDefinition = {
    id: 'wiki-read',
    name: 'Wiki Read',
    description: 'Read a wiki page by its slug. Returns the full page content.',
    parameters: [
      { name: 'slug', type: 'string', description: 'Page slug (e.g. "typescript-tips")', required: true },
    ] as ToolParameter[],
    sideEffects: false,
    requiresApproval: false,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const slug = params.slug as string;
    const start = Date.now();

    if (!slug) {
      return { success: false, data: null, summary: 'Error: slug is required', durationMs: Date.now() - start, includeInContext: true };
    }

    try {
      const content = await context.memory.wikiRead(slug);

      if (!content) {
        return {
          success: true,
          data: null,
          summary: `Wiki page "${slug}" not found`,
          durationMs: Date.now() - start,
        includeInContext: true,
        };
      }

      return {
        success: true,
        data: content,
        summary: content.slice(0, 500),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (e) {
      return {
        success: false,
        data: null,
        summary: `Error reading wiki page: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
/**
 * Lodestone — Wiki Resolve Tool
 *
 * Resolves [[wikilinks]] to file paths, frontmatter, and content snippets.
 * Core tool for the knowledge system — lets the agent navigate the wiki.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

const definition: ToolDefinition = {
  id: 'wiki-resolve',
  name: 'Wiki Resolve',
  description: 'Resolve a [[wikilink]] to its file path, frontmatter, and snippet. Input: wikilink text without brackets.',
  parameters: [
    { name: 'link', description: 'Wikilink to resolve (without brackets)', type: 'string', required: true },
  ],
  sideEffects: false,
  requiresApproval: false,
};

export class WikiResolveTool implements Tool {
  readonly definition = definition;

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const link = (params.link as string).replace(/^\[\[|\]\]$/g, '');
    const start = Date.now();

    try {
      const page = await context.memory.wikiRead(link);

      if (!page) {
        return {
          success: false,
          data: null,
          summary: `Wiki page "${link}" not found`,
          error: `No wiki page found for "${link}". Searched in all categories.`,
          durationMs: Date.now() - start,
          includeInContext: true,
        };
      }

      // Truncate content for context efficiency
      const maxSnippetLength = 500;
      const snippet = page.length > maxSnippetLength
        ? page.slice(0, maxSnippetLength) + '...'
        : page;

      return {
        success: true,
        data: { slug: link, content: snippet, fullPath: page },
        summary: `Resolved [[${link}]] — ${snippet.slice(0, 100)}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Failed to resolve [[${link}]]`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}

/**
 * Lodestone — Wiki Search Tool
 *
 * Search wiki pages by title, slug, or tag.
 */

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
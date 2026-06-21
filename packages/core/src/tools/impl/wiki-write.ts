/**
 * Wiki Write Tool — write a page to the wiki with frontmatter
 */
import type { Tool, ToolContext, ToolDefinition, ToolParameter, ToolResult } from '../definitions.js';

export class WikiWriteTool implements Tool {
  definition: ToolDefinition = {
    id: 'wiki-write',
    name: 'Wiki Write',
    description: 'Write a page to the wiki (knowledge base). Creates or updates a markdown page with YAML frontmatter. Use this to store knowledge, notes, or documentation.',
    parameters: [
      { name: 'slug', type: 'string', description: 'Page slug (kebab-case, e.g. "typescript-tips")', required: true },
      { name: 'content', type: 'string', description: 'Page content (markdown)', required: true },
      { name: 'title', type: 'string', description: 'Page title for frontmatter', required: false },
      { name: 'tags', type: 'string', description: 'Comma-separated tags', required: false },
    ] as ToolParameter[],
    sideEffects: true,
    requiresApproval: false,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const slug = params.slug as string;
    const content = params.content as string;
    const title = params.title as string | undefined;
    const tags = params.tags as string | undefined;
    const start = Date.now();

    if (!slug || !content) {
      return { success: false, data: null, summary: 'Error: slug and content are required', durationMs: Date.now() - start, includeInContext: true };
    }

    const tagArray = tags ? tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];

    try {
      await context.memory.wikiWrite(slug, content, {
        title: title || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        status: 'active',
        tags: tagArray.length > 0 ? tagArray : ['general'],
        agents: ['agent'],
        source: 'tool:wiki-write',
      });

      return {
        success: true,
        data: { slug, length: content.length },
        summary: `Wiki page "${slug}" written successfully (${content.length} chars)`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (e) {
      return {
        success: false,
        data: null,
        summary: `Error writing wiki page: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
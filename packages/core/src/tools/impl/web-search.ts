/**
 * Lodestone Tool — Web Search
 *
 * Searches the web using SearXNG (self-hosted) or Brave Search API.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface WebSearchConfig {
  provider: 'searxng' | 'brave';
  searxngUrl?: string;
  braveApiKey?: string;
  defaultCount?: number;
}

export class WebSearchTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for current information. Returns titles, URLs, and snippets.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'count', type: 'number', description: 'Number of results (default: 5)', required: false },
    ],
    sideEffects: false,
    requiresApproval: false,
    timeout: 15000,
  };

  constructor(private config: WebSearchConfig) {}

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;
    const count = (params.count as number) || this.config.defaultCount || 5;
    const start = Date.now();

    try {
      const results = this.config.provider === 'searxng'
        ? await this.searchSearXNG(query, count)
        : await this.searchBrave(query, count);

      return {
        success: true,
        data: results,
        summary: `${results.length} results for "${query}"`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Search failed: ${err}`,
        error: String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  private async searchSearXNG(query: string, count: number) {
    const url = `${this.config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&count=${count}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
    const data = await res.json() as { results: Array<{ title?: string; url?: string; content?: string }> };
    return data.results.slice(0, count).map(r => ({
      title: r.title, url: r.url, snippet: r.content, source: 'searxng',
    }));
  }

  private async searchBrave(query: string, count: number) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, { headers: { 'X-Subscription-Token': this.config.braveApiKey || '' } });
    if (!res.ok) throw new Error(`Brave returned ${res.status}`);
    const data = await res.json() as { web: { results: Array<{ title?: string; url?: string; description?: string }> } };
    return data.web.results.slice(0, count).map(r => ({
      title: r.title, url: r.url, snippet: r.description, source: 'brave',
    }));
  }
}
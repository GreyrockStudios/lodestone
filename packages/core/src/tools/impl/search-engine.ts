/**
 * Lodestone Tool — Search Engine
 *
 * Web search via Google Custom Search, Bing Search API, or SearXNG.
 * Automatically selects the first available provider based on environment variables.
 *
 * Providers (checked in order):
 * 1. Google Custom Search JSON API — requires GOOGLE_CSE_ID + GOOGLE_API_KEY
 * 2. Bing Search API v7 — requires BING_API_KEY
 * 3. SearXNG instance — requires SEARXNG_URL
 *
 * Returns normalized results: [{ title, url, snippet, displayUrl }]
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
}

type Provider = 'google' | 'bing' | 'searxng' | 'none';

// ─── Tool ───────────────────────────────────────────────────────────────────

export class SearchEngineTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'search-engine',
    name: 'Search Engine',
    description:
      'Search the web for current information. Returns titles, URLs, and snippets. ' +
      'Supports pagination via the start parameter.',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query string',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: 'Number of results to return (default: 10)',
        required: false,
        default: 10,
      },
      {
        name: 'start',
        type: 'number',
        description: 'Result index to start from (for pagination, default: 1)',
        required: false,
        default: 1,
      },
      {
        name: 'safeSearch',
        type: 'boolean',
        description: 'Enable safe search filtering (default: true)',
        required: false,
        default: true,
      },
      {
        name: 'timeRange',
        type: 'string',
        description: 'Filter by time range: day, week, month, or year',
        required: false,
        enum: ['day', 'week', 'month', 'year'],
      },
    ],
    sideEffects: false,
    requiresApproval: false,
    timeout: 15000,
  };

  // ─── Provider Detection ──────────────────────────────────────────────────

  private detectProvider(): Provider {
    if (process.env.GOOGLE_CSE_ID && process.env.GOOGLE_API_KEY) return 'google';
    if (process.env.BING_API_KEY) return 'bing';
    if (process.env.SEARXNG_URL) return 'searxng';
    return 'none';
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const query = params.query as string;
    const count = (params.count as number) || 10;
    const startIndex = (params.start as number) || 1;
    const safeSearch = params.safeSearch !== false; // default true
    const timeRange = params.timeRange as string | undefined;

    if (!query) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: query',
        error: 'query is required',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const provider = this.detectProvider();

    try {
      let results: SearchResult[];

      switch (provider) {
        case 'google':
          results = await this.searchGoogle(query, count, startIndex, safeSearch, timeRange);
          break;
        case 'bing':
          results = await this.searchBing(query, count, startIndex, safeSearch, timeRange);
          break;
        case 'searxng':
          results = await this.searchSearXNG(query, count, safeSearch, timeRange);
          break;
        default:
          return {
            success: false,
            data: null,
            summary:
              'No search provider configured. Set GOOGLE_CSE_ID+GOOGLE_API_KEY, BING_API_KEY, or SEARXNG_URL.',
            error: 'NoSearchProvider',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }

      return {
        success: true,
        data: { query, provider, results, count: results.length },
        summary: `Found ${results.length} results for "${query}" via ${provider}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Search failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Google Custom Search ─────────────────────────────────────────────────

  private async searchGoogle(
    query: string,
    count: number,
    start: number,
    safeSearch: boolean,
    timeRange?: string,
  ): Promise<SearchResult[]> {
    const cseId = process.env.GOOGLE_CSE_ID!;
    const apiKey = process.env.GOOGLE_API_KEY!;
    const params = new URLSearchParams({
      q: query,
      key: apiKey,
      cx: cseId,
      num: String(Math.min(count, 10)), // Google CSE max 10 per request
      start: String(start),
      safe: safeSearch ? 'active' : 'off',
    });
    if (timeRange) params.set('dateRestrict', this.googleDateRestrict(timeRange));

    const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Lodestone/0.1' } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google CSE search failed (HTTP ${res.status}): ${body}. Check API key and CX ID.`);
    }

    const data = await res.json() as {
      items?: Array<{ title: string; link: string; snippet: string; displayLink: string }>;
    };
    return (data.items || []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet || '',
      displayUrl: item.displayLink || item.link,
    }));
  }

  private googleDateRestrict(range: string): string {
    switch (range) {
      case 'day': return 'd1';
      case 'week': return 'w1';
      case 'month': return 'm1';
      case 'year': return 'y1';
      default: return '';
    }
  }

  // ─── Bing Search API v7 ───────────────────────────────────────────────────

  private async searchBing(
    query: string,
    count: number,
    offset: number,
    safeSearch: string | boolean,
    timeRange?: string,
  ): Promise<SearchResult[]> {
    const apiKey = process.env.BING_API_KEY!;
    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 50)),
      offset: String(offset - 1), // Bing uses 0-based offset
      safeSearch: safeSearch ? 'Strict' : 'Off',
    });
    if (timeRange) {
      // Bing uses freshness: Day, Week, Month, or a date range
      const freshnessMap: Record<string, string> = {
        day: 'Day',
        week: 'Week',
        month: 'Month',
        year: '', // Bing doesn't have "Year" — skip
      };
      const f = freshnessMap[timeRange];
      if (f) params.set('freshness', f);
    }

    const url = `https://api.bing.microsoft.com/v7.0/search?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'User-Agent': 'Lodestone/0.1',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bing Search API failed (HTTP ${res.status}): ${body}. Check API key validity.`);
    }

    const data = await res.json() as {
      webPages?: {
        value: Array<{
          name: string;
          url: string;
          snippet: string;
          displayUrl: string;
        }>;
      };
    };
    const items = data.webPages?.value || [];
    return items.map((item) => ({
      title: item.name,
      url: item.url,
      snippet: item.snippet || '',
      displayUrl: item.displayUrl || item.url,
    }));
  }

  // ─── SearXNG ────────────────────────────────────────────────────────────────

  private async searchSearXNG(
    query: string,
    count: number,
    safeSearch: boolean,
    timeRange?: string,
  ): Promise<SearchResult[]> {
    const searxngUrl = process.env.SEARXNG_URL!;
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: '1',
      safesearch: safeSearch ? '1' : '0',
    });
    if (timeRange) {
      const timeMap: Record<string, string> = {
        day: 'day',
        week: 'week',
        month: 'month',
        year: 'year',
      };
      const t = timeMap[timeRange];
      if (t) params.set('time_range', t);
    }

    const url = `${searxngUrl}/search?${params.toString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Lodestone/0.1' } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SearXNG search failed (HTTP ${res.status}): ${body}. Check that SearXNG is running and reachable.`);
    }

    const data = await res.json() as {
      results?: Array<{
        title: string;
        url: string;
        content: string;
        pretty_url: string;
      }>;
    };
    const items = (data.results || []).slice(0, count);
    return items.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content || '',
      displayUrl: item.pretty_url || item.url,
    }));
  }
}
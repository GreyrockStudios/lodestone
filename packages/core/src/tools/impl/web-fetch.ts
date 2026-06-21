/**
 * Lodestone Tool — Web Fetch
 *
 * Fetches a URL and extracts readable content as markdown or text.
 * Uses a simple readability extractor — no external dependencies.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export class WebFetchTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'web-fetch',
    name: 'Web Fetch',
    description: 'Fetch a URL and extract readable content. Returns markdown or plain text.',
    parameters: [
      { name: 'url', type: 'string', description: 'HTTP(S) URL to fetch', required: true },
      { name: 'maxChars', type: 'number', description: 'Max chars to return (default: 10000)', required: false },
    ],
    sideEffects: false,
    requiresApproval: false,
    timeout: 20000,
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const url = params.url as string;
    const maxChars = (params.maxChars as number) || 10000;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Lodestone/0.1 (agent runtime)' },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);

      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();
      let extracted: string;

      if (contentType.includes('text/html')) {
        extracted = this.extractReadable(raw);
      } else if (contentType.includes('application/json')) {
        extracted = `json\n${raw}`;
      } else {
        extracted = raw;
      }

      // Truncate
      if (extracted.length > maxChars) {
        extracted = extracted.slice(0, maxChars) + '\n...[truncated]';
      }

      return {
        success: true,
        data: { url, content: extracted, contentType, length: extracted.length },
        summary: `Fetched ${url} (${extracted.length} chars)`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Fetch failed: ${err}`,
        error: String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  /** Simple HTML to text extraction */
  private extractReadable(html: string): string {
    // Remove script and style tags
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '');

    // Convert common elements to markdown-ish
    text = text
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gis, '\n$1\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // Collapse whitespace
    text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

    return text;
  }
}
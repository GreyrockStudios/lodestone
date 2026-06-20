/**
 * Memory Recall Tool — search long-term memory for relevant facts
 */
import type { Tool, ToolContext, ToolDefinition, ToolParameter, ToolResult } from '../definitions.js';

export class MemoryRecallTool implements Tool {
  definition: ToolDefinition = {
    id: 'memory-recall',
    name: 'Memory Recall',
    description: 'Search long-term memory for relevant facts and memories. Use this when you need to recall what you know about a topic, person, or preference.',
    parameters: [
      { name: 'query', type: 'string', description: 'What to search for in memory', required: true },
      { name: 'limit', type: 'number', description: 'Max results (default 5)', required: false },
    ] as ToolParameter[],
    sideEffects: false,
    requiresApproval: false,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;
    const limit = (params.limit as number) ?? 5;
    const start = Date.now();

    if (!query) {
      return { success: false, data: null, summary: 'Error: query is required', durationMs: Date.now() - start, includeInContext: true };
    }

    try {
      const results = await context.memory.recall(query, limit);

      if (results.length === 0) {
        return {
          success: true,
          data: [],
          summary: `No memories found for "${query}"`,
          durationMs: Date.now() - start,
        includeInContext: true,
        };
      }

      const formatted = results.map((r, i) => {
        // LanceDB cosine distance: 0 = identical, 2 = opposite. Convert to 0-100% similarity.
        const similarity = r.relevance !== undefined
          ? Math.max(0, Math.round((1 - r.relevance / 2) * 100))
          : null;
        const relStr = similarity !== null ? `${similarity}%` : 'N/A';
        return `${i + 1}. [${relStr}] ${r.text}`;
      });

      return {
        success: true,
        data: results,
        summary: `Found ${results.length} memories for "${query}":\n${formatted.join('\n')}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (e) {
      return {
        success: false,
        data: null,
        summary: `Error recalling memory: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Memory Store Tool — explicitly store a fact/memory into the vector store + wiki
 */
import type { Tool, ToolContext, ToolDefinition, ToolParameter, ToolResult } from '../definitions.js';

export class MemoryStoreTool implements Tool {
  definition: ToolDefinition = {
    id: 'memory-store',
    name: 'Memory Store',
    description: 'Store a fact, preference, or memory into long-term memory. Use this when the user says "remember this" or "note this" or when you want to persist important information.',
    parameters: [
      { name: 'text', type: 'string', description: 'The fact or memory to store', required: true },
      { name: 'category', type: 'string', description: 'Category: preference, fact, decision, entity, or other', required: false },
      { name: 'importance', type: 'number', description: 'Importance 0-1 (default 0.7)', required: false },
    ] as ToolParameter[],
    sideEffects: false,
    timeout: 15000,
    requiresApproval: false,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const text = params.text as string;
    const category = (params.category as string) || 'fact';
    const importance = (params.importance as number) ?? 0.7;
    const start = Date.now();

    if (!text || text.length < 3) {
      return { success: false, data: null, summary: 'Error: text is required and must be at least 3 characters', durationMs: Date.now() - start, includeInContext: true };
    }

    try {
      // Store via storeFact — triggers compounding (entity extraction, cross-referencing)
      await context.memory.storeFact(text, category, importance);

      // Write to wiki if high importance
      if (importance >= 0.7) {
        try {
          const slug = category === 'entity'
            ? text.replace(/^Entity mentioned:\s*/i, '').toLowerCase().replace(/\s+/g, '-')
            : `auto-${category}-${Date.now()}`;
          const existing = await context.memory.wikiRead(slug);
          if (!existing) {
            await context.memory.wikiWrite(slug, text, {
              title: text.split(' ').slice(0, 6).join(' '),
              status: 'active',
              tags: [category, 'explicit-store'],
              agents: ['memory-store-tool'],
              source: 'tool:memory-store',
            });
          }
        } catch {
          // Best-effort wiki write
        }
      }

      return {
        success: true,
        data: { text: text.slice(0, 100), category, importance },
        summary: `Stored in memory: "${text.slice(0, 80)}" (category: ${category}, importance: ${importance})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (e) {
      return {
        success: false,
        data: null,
        summary: `Error storing memory: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }
}
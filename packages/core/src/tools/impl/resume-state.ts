/**
 * Lodestone — Resume State Tool
 *
 * Save and restore task state across context compaction boundaries.
 * Critical for long-running tasks that exceed the context window.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

const definition: ToolDefinition = {
  id: 'resume-state',
  name: 'Resume State',
  description: 'Save/restore task state for session continuity across context compaction.',
  parameters: [
    { name: 'action', description: 'save, load, or clear', type: 'string', required: true },
    { name: 'currentTask', description: 'What I am currently working on', type: 'string', required: false },
    { name: 'progress', description: 'How far along', type: 'string', required: false },
    { name: 'blockedBy', description: 'What is blocking me', type: 'string', required: false },
    { name: 'nextSteps', description: 'What to do next (ordered)', type: 'array', required: false, items: { name: 'step', description: 'A next step', type: 'string', required: false } },
    { name: 'mood', description: 'Current state: focused, stuck, waiting, done', type: 'string', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

export class ResumeStateTool implements Tool {
  readonly definition = definition;

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    switch (action) {
      case 'save': {
        if (!params.currentTask) {
          return {
            success: false, data: null,
            summary: 'currentTask is required for save',
            error: 'Missing currentTask',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        await context.memory.scratchSet('resume-state', JSON.stringify({
          currentTask: params.currentTask,
          progress: params.progress || '',
          blockedBy: params.blockedBy,
          nextSteps: params.nextSteps || [],
          recentFiles: [], // Agent tracks this itself
          mood: params.mood,
          savedAt: new Date().toISOString(),
        }));

        return {
          success: true,
          data: { saved: true },
          summary: `State saved: ${params.currentTask}`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }

      case 'load': {
        const raw = await context.memory.scratchGet('resume-state');
        if (!raw) {
          return {
            success: true,
            data: null,
            summary: 'No saved state found',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        try {
          const state = JSON.parse(raw);
          return {
            success: true,
            data: state,
            summary: `State loaded: ${state.currentTask}`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        } catch {
          return {
            success: false, data: null,
            summary: 'Failed to parse saved state',
            error: 'Invalid JSON in resume state',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }
      }

      case 'clear': {
        // Can't delete from scratch buffer through MemoryAccess interface,
        // so we set it to empty
        await context.memory.scratchSet('resume-state', '');
        return {
          success: true,
          data: null,
          summary: 'Resume state cleared',
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }

      default:
        return {
          success: false, data: null,
          summary: `Unknown action: ${action}`,
          error: 'Valid actions: save, load, clear',
          durationMs: Date.now() - start,
          includeInContext: true,
        };
    }
  }
}
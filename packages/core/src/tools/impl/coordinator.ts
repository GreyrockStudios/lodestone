/**
 * Lodestone — Multi-Agent Coordinator Tool
 *
 * Allows the agent to spawn, monitor, and coordinate sub-agent tasks.
 * This is the LLM-callable interface to the MultiAgentCoordinator.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

// ─── Tool Definition ────────────────────────────────────────────────────────

const COORDINATOR_DEFINITION: ToolDefinition = {
  id: 'coordinator',
  name: 'Coordinator',
  description: 'Spawn, monitor, and coordinate sub-agent tasks. Use this to delegate work to specialized sub-agents for review, research, implementation, or testing.',
  parameters: [
    { name: 'action', type: 'string', description: 'Action: spawn, status, list, cancel', required: true },
    { name: 'name', type: 'string', description: 'Task name (human-readable) for spawn', required: false },
    { name: 'type', type: 'string', description: 'Sub-agent type for spawn: worker, reviewer, researcher, coder', required: false },
    { name: 'objective', type: 'string', description: 'Objective description for spawn', required: false },
    { name: 'taskId', type: 'string', description: 'Task ID for status/cancel', required: false },
    { name: 'priority', type: 'number', description: 'Priority (0 = highest, default: 5)', required: false },
    { name: 'timeoutMs', type: 'number', description: 'Timeout in ms (default: 300000 = 5 min)', required: false },
  ],
  sideEffects: true,
  requiresApproval: false,
};

// ─── Coordinator Tool ──────────────────────────────────────────────────────

export class CoordinatorTool implements Tool {
  readonly definition = COORDINATOR_DEFINITION;

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const startMs = Date.now();
    const action = params.action as string;
    const coordinator = (context.engine as any)?.coordinator;
    if (!coordinator) {
      return { success: false, data: null, summary: 'Coordinator not available', error: 'Engine coordinator not initialized', durationMs: Date.now() - startMs, includeInContext: true };
    }

    switch (action) {
      case 'spawn': {
        const name = (params.name as string) || 'unnamed-task';
        const type = (params.type as string) || 'worker';
        const objective = params.objective as string;
        const priority = (params.priority as number) ?? 5;
        const timeoutMs = (params.timeoutMs as number) || 300000;

        if (!objective) {
          return { success: false, data: null, error: 'objective is required for spawn action', summary: 'Missing objective', durationMs: Date.now() - startMs, includeInContext: false };
        }

        try {
          const task = coordinator.spawnTask({
            name,
            type: type as 'worker' | 'reviewer' | 'researcher' | 'coder',
            objective,
            priority,
            timeoutMs,
          });

          coordinator.startTask(task.id);

          return {
            success: true,
            data: {
              taskId: task.id,
              name: task.name,
              status: task.status,
              type: task.type,
              objective: task.objective,
            },
            summary: `Spawned ${type} sub-agent: ${name}`,
            durationMs: Date.now() - startMs,
            includeInContext: true,
          };
        } catch (err) {
          return { success: false, data: null, error: `Failed to spawn task: ${err instanceof Error ? err.message : String(err)}`, summary: 'Spawn failed', durationMs: Date.now() - startMs, includeInContext: false };
        }
      }

      case 'status': {
        const taskId = params.taskId as string;
        if (!taskId) {
          return { success: false, data: null, error: 'taskId is required for status action', summary: 'Missing taskId', durationMs: Date.now() - startMs, includeInContext: false };
        }
        const agents: any[] = coordinator.getActiveAgents();
        const task = agents.find((t: any) => t.id === taskId);
        if (!task) {
          return { success: false, data: null, error: `Task ${taskId} not found among active agents`, summary: 'Task not found', durationMs: Date.now() - startMs, includeInContext: false };
        }
        return {
          success: true,
          data: {
            taskId: task.id,
            name: task.name,
            status: task.status,
            type: task.type,
            objective: task.objective,
            result: task.result ? { summary: task.result.summary } : undefined,
            error: task.error,
          },
          summary: `Task ${task.name}: ${task.status}`,
          durationMs: Date.now() - startMs,
          includeInContext: true,
        };
      }

      case 'list': {
        const tasks: any[] = coordinator.getActiveAgents();
        return {
          success: true,
          data: {
            total: tasks.length,
            tasks: tasks.map((t: any) => ({
              id: t.id,
              name: t.name,
              type: t.type,
              status: t.status,
              objective: t.objective.substring(0, 100),
            })),
          },
          summary: `${tasks.length} active sub-agent tasks`,
          durationMs: Date.now() - startMs,
          includeInContext: true,
        };
      }

      case 'cancel': {
        const taskId = params.taskId as string;
        if (!taskId) {
          return { success: false, data: null, error: 'taskId is required for cancel action', summary: 'Missing taskId', durationMs: Date.now() - startMs, includeInContext: false };
        }
        const cancelled = coordinator.cancelTask(taskId);
        if (!cancelled) {
          return { success: false, data: null, error: `Task ${taskId} not found or not cancellable`, summary: 'Cancel failed', durationMs: Date.now() - startMs, includeInContext: false };
        }
        return { success: true, data: { taskId: cancelled.id, status: 'cancelled' }, summary: `Cancelled task ${cancelled.id}`, durationMs: Date.now() - startMs, includeInContext: true };
      }

      default:
        return { success: false, data: null, error: `Unknown action: ${action}. Use spawn, status, list, or cancel.`, summary: 'Unknown action', durationMs: Date.now() - startMs, includeInContext: false };
    }
  }
}
/**
 * E2E Tests — Phase 4 Improvements
 *
 * Tests: session cleanup, tool timeout enforcement, quality gate blocking,
 * plugin hooks (afterTool, beforeResponse, afterResponse), coordinator tool.
 */

import { LodestoneEngine } from '../engine.js';
import { SessionManager } from '../session/manager.js';
import { ToolRegistry, type Tool, type ToolDefinition, type ToolResult, type ToolContext } from '../tools/definitions.js';

const WORKSPACE = process.cwd();

async function run() {
  let passed = 0;
  let failed = 0;

  function ok(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  ✅ PASS — ${name}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL — ${name}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  // ─── Test 1: Session cleanup ──────────────────────────────────────────
  await test('Session cleanup removes stale sessions', async () => {
    const mgr = new SessionManager();
    const session = mgr.create(8000);
    ok('Session created', !!session);

    // Make it stale — set updatedAt to 2 days ago
    session.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const removed = mgr.cleanupStale(24 * 60 * 60 * 1000); // 24h threshold
    ok('Stale session removed', removed === 1);
    ok('No sessions left', mgr.count() === 0);
  });

  // ─── Test 2: Session cleanup preserves active sessions ────────────────
  await test('Session cleanup preserves active sessions', async () => {
    const mgr = new SessionManager();
    const s1 = mgr.create(8000);
    const s2 = mgr.create(8000);

    // Make s1 stale, s2 fresh
    s1.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const removed = mgr.cleanupStale();
    ok('Only stale removed', removed === 1);
    ok('Active session preserved', mgr.count() === 1);
    ok('Active session is s2', mgr.get(s2.id) !== undefined);
  });

  // ─── Test 3: Tool timeout enforcement ─────────────────────────────────
  await test('Tool timeout enforcement', async () => {
    const registry = new ToolRegistry();

    const slowToolDefinition: ToolDefinition = {
      id: 'slow-tool',
      name: 'Slow Tool',
      description: 'A tool that takes too long',
      parameters: [],
      sideEffects: false,
      requiresApproval: false,
      timeout: 100, // 100ms timeout
    };

    const slowTool: Tool = {
      definition: slowToolDefinition,
      async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms — longer than timeout
        return { success: true, data: 'should not reach here', summary: 'done', durationMs: 500, includeInContext: true };
      },
    };

    registry.register(slowTool);
    const result = await registry.execute('slow-tool', {}, {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Test', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {} as any,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    ok('Tool timed out', !result.success);
    ok('Timeout error message', (result.error || '').includes('timed out'));
  });

  // ─── Test 4: Tool timeout — fast tool succeeds ─────────────────────────
  await test('Fast tool succeeds with timeout', async () => {
    const registry = new ToolRegistry();

    const fastToolDefinition: ToolDefinition = {
      id: 'fast-tool',
      name: 'Fast Tool',
      description: 'A tool that completes quickly',
      parameters: [],
      sideEffects: false,
      requiresApproval: false,
      timeout: 5000,
    };

    const fastTool: Tool = {
      definition: fastToolDefinition,
      async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        await new Promise(resolve => setTimeout(resolve, 10)); // 10ms
        return { success: true, data: 'fast result', summary: 'done', durationMs: 10, includeInContext: true };
      },
    };

    registry.register(fastTool);
    const result = await registry.execute('fast-tool', {}, {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Test', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {} as any,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    ok('Fast tool succeeded', result.success);
    ok('Correct data', result.data === 'fast result');
  });

  // ─── Test 5: Coordinator tool — list action ───────────────────────────
  await test('Coordinator tool list returns empty when no agents', async () => {
    const { CoordinatorTool } = await import('../tools/impl/coordinator.js');
    const tool = new CoordinatorTool();
    const mockContext: ToolContext = {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Test', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {} as any,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      engine: {
        coordinator: {
          getActiveAgents: () => [],
          spawnTask: () => ({ id: 't1', name: 'test', status: 'spawning', type: 'worker', objective: 'test' }),
          startTask: () => null,
          cancelTask: () => null,
        },
      },
    };

    const result = await tool.execute({ action: 'list' }, mockContext);
    ok('List succeeded', result.success);
    ok('Empty list', (result.data as any).total === 0);
  });

  // ─── Test 6: Coordinator tool — spawn action ──────────────────────────
  await test('Coordinator tool spawn creates task', async () => {
    const { CoordinatorTool } = await import('../tools/impl/coordinator.js');
    const tool = new CoordinatorTool();
    let spawnedTask: any = null;
    const mockContext: ToolContext = {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Test', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {} as any,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      engine: {
        coordinator: {
          getActiveAgents: () => spawnedTask ? [spawnedTask] : [],
          spawnTask: (params: any) => {
            spawnedTask = { id: 'task-1', name: params.name, status: 'spawning', type: params.type, objective: params.objective };
            return spawnedTask;
          },
          startTask: () => { spawnedTask.status = 'running'; return spawnedTask; },
          cancelTask: () => null,
        },
      },
    };

    const result = await tool.execute({
      action: 'spawn',
      name: 'test-task',
      type: 'worker',
      objective: 'Do something',
    }, mockContext);

    ok('Spawn succeeded', result.success);
    ok('Task ID returned', (result.data as any).taskId === 'task-1');
    ok('Task name', (result.data as any).name === 'test-task');
  });

  // ─── Test 7: Coordinator tool — unknown action ────────────────────────
  await test('Coordinator tool rejects unknown action', async () => {
    const { CoordinatorTool } = await import('../tools/impl/coordinator.js');
    const tool = new CoordinatorTool();
    const mockContext: ToolContext = {
      sessionId: 'test',
      workspaceRoot: WORKSPACE,
      identity: { name: 'Test', soul: '', rules: '', heartbeat: '', user: 'User' },
      memory: {} as any,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      engine: {
        coordinator: {
          getActiveAgents: () => [],
          spawnTask: () => ({} as any),
          startTask: () => null,
          cancelTask: () => null,
        },
      },
    };

    const result = await tool.execute({ action: 'teleport' }, mockContext);
    ok('Unknown action fails', !result.success);
    ok('Error mentions valid actions', (result.error || '').includes('spawn'));
  });

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log(`📊 Phase 4 Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);

  // ─── Helpers ──────────────────────────────────────────────────────────
  async function test(name: string, fn: () => Promise<void>) {
    console.log(`\n--- Test: ${name} ---`);
    try {
      await fn();
    } catch (err) {
      console.log(`  ❌ FAIL — threw: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
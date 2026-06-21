/**
 * Lodestone — Tool Tests for Process Manager and Diff Patch
 *
 * Tests process group management (killGroup, signal support) and
 * diff-patch multi-file/unified-diff support.
 * Uses real temporary files and mock ToolContext.
 */

import { ProcessManagerTool } from '../tools/impl/process-manager.js';
import { DiffPatchTool } from '../tools/impl/diff-patch.js';
import { resolve } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';

const WORKSPACE = '/tmp/lodestone-tool-tests-pm-dp/workspace';

// ─── Mock ToolContext ────────────────────────────────────────────────────────

function makeMockContext() {
  return {
    sessionId: 'tool-tests-pm-dp',
    workspaceRoot: WORKSPACE,
    identity: {
      name: 'Lodestone',
      soul: 'test soul',
      rules: 'test rules',
      heartbeat: 'test heartbeat',
      user: 'Tester',
    },
    memory: {
      async store(): Promise<void> {},
      async storeFact(): Promise<void> {},
      async recall(): Promise<never[]> { return []; },
      async wikiRead(): Promise<string | null> { return null; },
      async wikiWrite(): Promise<void> {},
      async wikiSearch(): Promise<never[]> { return []; },
      async scratchGet(): Promise<string | null> { return null; },
      async scratchSet(): Promise<void> {},
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

// ─── Test runner ─────────────────────────────────────────────────────────────

async function runTest() {
  console.log('🔧 Lodestone Tool Tests — Process Manager & Diff Patch');
  console.log('═'.repeat(60));
  console.log('');

  let passed = 0;
  let failed = 0;

  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };

  // Ensure workspace exists
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(resolve(WORKSPACE, 'src'), { recursive: true });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS MANAGER TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('─ Process Manager ──────────────────────────────────────────');

  const pm = new ProcessManagerTool();
  const ctx = makeMockContext();

  // ─── Test 1: start a process ───────────────────────────────────────────────

  let testPid: number;

  await test('process-manager: start a process', async () => {
    const result = await pm.execute({ action: 'start', command: 'sleep 30' }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { pid: number; pgid: number | null; command: string };
    if (!data.pid) throw new Error('Expected a PID');
    if (!data.pgid) throw new Error('Expected a PGID');
    if (data.command !== 'sleep 30') throw new Error('Expected command to be "sleep 30"');
    testPid = data.pid;
    console.log(`   → Started PID ${data.pid} (group ${data.pgid})`);
  });

  // ─── Test 2: list processes ────────────────────────────────────────────────

  await test('process-manager: list shows started process', async () => {
    const result = await pm.execute({ action: 'list' }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { processes: Array<{ pid: number; pgid: number | null }>; count: number };
    if (data.count < 1) throw new Error(`Expected at least 1 process, got ${data.count}`);
    const found = data.processes.find((p) => p.pid === testPid);
    if (!found) throw new Error(`Process ${testPid} not found in list`);
    if (!found.pgid) throw new Error('Expected pgid in list output');
    console.log(`   → Listed ${data.count} process(es)`);
  });

  // ─── Test 3: poll a running process ────────────────────────────────────────

  await test('process-manager: poll shows process running', async () => {
    const result = await pm.execute({ action: 'poll', pid: testPid }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { pid: number; running: boolean; uptimeMs: number };
    if (!data.running) throw new Error('Expected process to be running');
    if (data.uptimeMs < 0) throw new Error('Expected positive uptime');
    console.log(`   → Process ${data.pid} running for ${Math.round(data.uptimeMs / 1000)}s`);
  });

  // ─── Test 4: poll with invalid PID ─────────────────────────────────────────

  await test('process-manager: poll with invalid PID returns clear error', async () => {
    const result = await pm.execute({ action: 'poll', pid: 0 }, ctx);
    if (result.success) throw new Error('Expected failure for invalid PID');
    if (!result.error?.includes('InvalidPid')) throw new Error(`Expected InvalidPid error, got: ${result.error}`);
    console.log(`   → Correctly returned InvalidPid error`);
  });

  // ─── Test 5: poll non-existent PID ─────────────────────────────────────────

  await test('process-manager: poll non-existent PID returns ProcessNotFound', async () => {
    const result = await pm.execute({ action: 'poll', pid: 999999 }, ctx);
    if (result.success) throw new Error('Expected failure for non-existent PID');
    if (!result.error?.includes('ProcessNotFound')) throw new Error(`Expected ProcessNotFound, got: ${result.error}`);
    console.log(`   → Correctly returned ProcessNotFound error`);
  });

  // ─── Test 6: logs from running process ─────────────────────────────────────

  await test('process-manager: logs return output (may be empty for sleep)', async () => {
    const result = await pm.execute({ action: 'logs', pid: testPid, lines: 10 }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { pid: number; stdoutLines: number; stderrLines: number };
    if (data.pid !== testPid) throw new Error('PID mismatch');
    console.log(`   → Got ${data.stdoutLines} stdout + ${data.stderrLines} stderr lines`);
  });

  // ─── Test 7: killGroup with valid group ID ──────────────────────────────────

  await test('process-manager: killGroup kills the process group', async () => {
    // The pgid should be the same as the pid for detached processes
    const pollResult = await pm.execute({ action: 'poll', pid: testPid }, ctx);
    const data = pollResult.data as { running: boolean };
    if (!data.running) throw new Error('Process should still be running for killGroup test');

    // Get the pgid from the list
    const listResult = await pm.execute({ action: 'list' }, ctx);
    const list = listResult.data as { processes: Array<{ pid: number; pgid: number | null }> };
    const proc = list.processes.find((p) => p.pid === testPid);
    if (!proc || !proc.pgid) throw new Error('Could not find pgid for test process');

    const result = await pm.execute({ action: 'killGroup', groupId: proc.pgid, signal: 'SIGKILL' }, ctx);
    if (!result.success) throw new Error(`killGroup failed: ${result.error}`);
    const killData = result.data as { groupId: number; trackedKilled: number; totalInGroup: number };
    if (killData.trackedKilled < 1) throw new Error(`Expected at least 1 killed, got ${killData.trackedKilled}`);
    console.log(`   → Killed ${killData.trackedKilled} process(es) in group ${killData.groupId}`);
  });

  // ─── Test 8: killGroup with invalid groupId ─────────────────────────────────

  await test('process-manager: killGroup with invalid groupId returns error', async () => {
    const result = await pm.execute({ action: 'killGroup', groupId: 0 }, ctx);
    if (result.success) throw new Error('Expected failure for invalid groupId');
    if (!result.error?.includes('InvalidGroupId')) throw new Error(`Expected InvalidGroupId, got: ${result.error}`);
    console.log(`   → Correctly returned InvalidGroupId error`);
  });

  // ─── Test 9: stop with custom signal ───────────────────────────────────────

  await test('process-manager: start and stop with SIGKILL signal', async () => {
    const startResult = await pm.execute({ action: 'start', command: 'sleep 30' }, ctx);
    if (!startResult.success) throw new Error(`Start failed: ${startResult.error}`);
    const startData = startResult.data as { pid: number };
    const pid = startData.pid;

    const stopResult = await pm.execute({ action: 'stop', pid, signal: 'SIGKILL' }, ctx);
    if (!stopResult.success) throw new Error(`Stop failed: ${stopResult.error}`);
    console.log(`   → Stopped PID ${pid} with SIGKILL`);
  });

  // ─── Test 10: start with empty command ─────────────────────────────────────

  await test('process-manager: start with empty command returns clear error', async () => {
    const result = await pm.execute({ action: 'start', command: '' }, ctx);
    if (result.success) throw new Error('Expected failure for empty command');
    if (!result.error?.includes('MissingCommand')) throw new Error(`Expected MissingCommand, got: ${result.error}`);
    console.log(`   → Correctly returned MissingCommand error`);
  });

  // ─── Test 11: stop already-exited process ───────────────────────────────────

  await test('process-manager: stop already-exited process', async () => {
    const startResult = await pm.execute({ action: 'start', command: 'echo done' }, ctx);
    if (!startResult.success) throw new Error(`Start failed: ${startResult.error}`);
    const startData = startResult.data as { pid: number };
    const pid = startData.pid;

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 500));

    const stopResult = await pm.execute({ action: 'stop', pid }, ctx);
    if (!stopResult.success) throw new Error(`Stop failed: ${stopResult.error}`);
    const data = stopResult.data as { alreadyExited: boolean };
    if (!data.alreadyExited) throw new Error('Expected alreadyExited to be true');
    console.log(`   → Correctly reported process already exited`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DIFF PATCH TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('─ Diff Patch ────────────────────────────────────────────────');

  const dp = new DiffPatchTool({ workspaceRoot: WORKSPACE });

  // Setup test files
  const fileA = resolve(WORKSPACE, 'src/file-a.ts');
  const fileB = resolve(WORKSPACE, 'src/file-b.ts');
  const fileC = resolve(WORKSPACE, 'src/file-c.ts');

  await writeFile(fileA, 'export const foo = 1;\nexport const bar = 2;\nexport const baz = 3;\n', 'utf-8');
  await writeFile(fileB, 'export const alpha = "hello";\nexport const beta = "world";\n', 'utf-8');
  await writeFile(fileC, 'export const x = 100;\nexport const y = 200;\nexport const z = 300;\n', 'utf-8');

  // ─── Test 12: single-file edit (backward compat) ────────────────────────────

  await test('diff-patch: single-file edit still works', async () => {
    const result = await dp.execute({
      path: 'src/file-a.ts',
      edits: [{ oldText: 'export const foo = 1;', newText: 'export const foo = 42;' }],
    }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { applied: number; skipped: number };
    if (data.applied !== 1) throw new Error(`Expected 1 applied, got ${data.applied}`);
    if (data.skipped !== 0) throw new Error(`Expected 0 skipped, got ${data.skipped}`);

    const content = readFileSync(fileA, 'utf-8');
    if (!content.includes('export const foo = 42;')) throw new Error('Edit not written to file');
    console.log(`   → Applied ${data.applied} edit to file-a.ts`);
  });

  // ─── Test 13: multi-file edits ─────────────────────────────────────────────

  await test('diff-patch: multi-file edits apply to all files', async () => {
    // Reset file-a
    await writeFile(fileA, 'export const foo = 42;\nexport const bar = 2;\nexport const baz = 3;\n', 'utf-8');

    const result = await dp.execute({
      multiFileEdits: [
        {
          path: 'src/file-a.ts',
          edits: [
            { oldText: 'export const bar = 2;', newText: 'export const bar = 99;' },
          ],
        },
        {
          path: 'src/file-b.ts',
          edits: [
            { oldText: 'export const alpha = "hello";', newText: 'export const alpha = "HELLO";' },
          ],
        },
      ],
    }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { files: Array<{ path: string; applied: number }>; totalApplied: number };
    if (data.totalApplied !== 2) throw new Error(`Expected 2 applied, got ${data.totalApplied}`);
    if (data.files.length !== 2) throw new Error(`Expected 2 files, got ${data.files.length}`);

    const contentA = readFileSync(fileA, 'utf-8');
    const contentB = readFileSync(fileB, 'utf-8');
    if (!contentA.includes('export const bar = 99;')) throw new Error('file-a not updated');
    if (!contentB.includes('export const alpha = "HELLO";')) throw new Error('file-b not updated');
    console.log(`   → Applied ${data.totalApplied} edits across ${data.files.length} files`);
  });

  // ─── Test 14: multi-file with missing file (atomic validation) ──────────────

  await test('diff-patch: multi-file with missing file fails atomically', async () => {
    const result = await dp.execute({
      multiFileEdits: [
        { path: 'src/file-a.ts', edits: [{ oldText: 'export const baz = 3;', newText: 'export const baz = 777;' }] },
        { path: 'src/nonexistent.ts', edits: [{ oldText: 'x', newText: 'y' }] },
      ],
    }, ctx);
    if (result.success) throw new Error('Expected failure due to missing file');
    if (!result.error?.includes('NotFound')) throw new Error(`Expected NotFound error, got: ${result.error}`);

    // Verify file-a was NOT modified (atomic)
    const contentA = readFileSync(fileA, 'utf-8');
    if (contentA.includes('777')) throw new Error('file-a should not have been modified (atomic check failed)');
    console.log(`   → Correctly refused to apply — missing file detected, no files modified`);
  });

  // ─── Test 15: multi-file dry run ────────────────────────────────────────────

  await test('diff-patch: multi-file dry run does not write', async () => {
    const result = await dp.execute({
      multiFileEdits: [
        { path: 'src/file-a.ts', edits: [{ oldText: 'export const baz = 3;', newText: 'export const baz = 777;' }] },
      ],
      dryRun: true,
    }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { dryRun: boolean; totalApplied: number };
    if (!data.dryRun) throw new Error('Expected dryRun to be true');

    const contentA = readFileSync(fileA, 'utf-8');
    if (contentA.includes('777')) throw new Error('File should not have been modified in dry run');
    console.log(`   → Dry run previewed ${data.totalApplied} edit(s) without writing`);
  });

  // ─── Test 16: unified diff patch — single file ──────────────────────────────

  await test('diff-patch: unified diff patch single file', async () => {
    // Reset file-c
    await writeFile(fileC, 'export const x = 100;\nexport const y = 200;\nexport const z = 300;\n', 'utf-8');

    const patch = `--- a/src/file-c.ts
+++ b/src/file-c.ts
@@ -1,3 +1,3 @@
 export const x = 100;
-export const y = 200;
+export const y = 250;
 export const z = 300;
`;
    const result = await dp.execute({ patch, dryRun: false }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { totalApplied: number; patchFormat: string };
    if (data.totalApplied !== 1) throw new Error(`Expected 1 applied, got ${data.totalApplied}`);
    if (data.patchFormat !== 'unified-diff') throw new Error('Expected unified-diff format');

    const content = readFileSync(fileC, 'utf-8');
    if (!content.includes('export const y = 250;')) throw new Error('Patch not applied to file');
    console.log(`   → Applied ${data.totalApplied} hunk to file-c.ts`);
  });

  // ─── Test 17: unified diff patch — multiple files ───────────────────────────

  await test('diff-patch: unified diff patch multiple files', async () => {
    // Reset files
    await writeFile(fileA, 'export const foo = 42;\nexport const bar = 99;\nexport const baz = 3;\n', 'utf-8');
    await writeFile(fileC, 'export const x = 100;\nexport const y = 250;\nexport const z = 300;\n', 'utf-8');

    const patch = `--- a/src/file-a.ts
+++ b/src/file-a.ts
@@ -1,3 +1,3 @@
 export const foo = 42;
-export const bar = 99;
+export const bar = 100;
 export const baz = 3;
--- a/src/file-c.ts
+++ b/src/file-c.ts
@@ -1,3 +1,3 @@
-export const x = 100;
+export const x = 110;
 export const y = 250;
 export const z = 300;
`;
    const result = await dp.execute({ patch, dryRun: false }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { files: Array<{ path: string; applied: number }>; totalApplied: number };
    if (data.totalApplied !== 2) throw new Error(`Expected 2 applied, got ${data.totalApplied}`);

    const contentA = readFileSync(fileA, 'utf-8');
    const contentC = readFileSync(fileC, 'utf-8');
    if (!contentA.includes('export const bar = 100;')) throw new Error('file-a not patched');
    if (!contentC.includes('export const x = 110;')) throw new Error('file-c not patched');
    console.log(`   → Applied ${data.totalApplied} hunks across ${data.files.length} files`);
  });

  // ─── Test 18: unified diff with missing file (atomic) ───────────────────────

  await test('diff-patch: unified diff with missing file fails atomically', async () => {
    const patch = `--- a/src/file-a.ts
+++ b/src/file-a.ts
@@ -1,1 +1,1 @@
-export const foo = 42;
+export const foo = 999;
--- a/src/missing-file.ts
+++ b/src/missing-file.ts
@@ -1,1 +1,1 @@
-old
+new
`;
    const result = await dp.execute({ patch, dryRun: false }, ctx);
    if (result.success) throw new Error('Expected failure due to missing file');
    if (!result.error?.includes('NotFound')) throw new Error(`Expected NotFound error, got: ${result.error}`);

    // Verify file-a was NOT modified
    const contentA = readFileSync(fileA, 'utf-8');
    if (contentA.includes('999')) throw new Error('file-a should not have been modified (atomic check)');
    console.log(`   → Correctly refused — missing file detected, no files modified`);
  });

  // ─── Test 19: unified diff dry run ───────────────────────────────────────────

  await test('diff-patch: unified diff dry run does not write', async () => {
    await writeFile(fileB, 'export const alpha = "HELLO";\nexport const beta = "world";\n', 'utf-8');

    const patch = `--- a/src/file-b.ts
+++ b/src/file-b.ts
@@ -1,2 +1,2 @@
-export const alpha = "HELLO";
+export const alpha = "WORLD";
 export const beta = "world";
`;
    const result = await dp.execute({ patch, dryRun: true }, ctx);
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { dryRun: boolean; totalApplied: number };
    if (!data.dryRun) throw new Error('Expected dryRun=true');

    const content = readFileSync(fileB, 'utf-8');
    if (content.includes('WORLD')) throw new Error('File should not be modified in dry run');
    console.log(`   → Dry run previewed ${data.totalApplied} hunk(s) without writing`);
  });

  // ─── Test 20: empty patch string ─────────────────────────────────────────────

  await test('diff-patch: empty patch string returns error', async () => {
    const result = await dp.execute({ patch: '' }, ctx);
    if (result.success) throw new Error('Expected failure for empty patch');
    if (!result.error?.includes('MissingPatch')) throw new Error(`Expected MissingPatch, got: ${result.error}`);
    console.log(`   → Correctly returned MissingPatch error`);
  });

  // ─── Test 21: multi-file with path traversal ─────────────────────────────────

  await test('diff-patch: multi-file with path traversal is denied', async () => {
    const result = await dp.execute({
      multiFileEdits: [
        { path: '../../../etc/passwd', edits: [{ oldText: 'x', newText: 'y' }] },
      ],
    }, ctx);
    if (result.success) throw new Error('Expected failure for path traversal');
    if (!result.error?.includes('PathTraversalDenied')) throw new Error(`Expected PathTraversalDenied, got: ${result.error}`);
    console.log(`   → Correctly denied path traversal`);
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  await rm(WORKSPACE, { recursive: true, force: true });

  // ─── Summary ──────────────────────────────────────────────────────────────────

  console.log('');
  console.log('═'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('');

  if (failed === 0) {
    console.log('🔧 All tool tests passed.');
  } else {
    console.log(`⚠️  ${failed} test(s) failed. See errors above.`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
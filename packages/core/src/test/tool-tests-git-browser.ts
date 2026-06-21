/**
 * Lodestone — Tool Tests for git.ts (listBranches, merge, currentBranch)
 *                              and browser.ts (enhanced screenshot)
 *
 * Tests new tool methods directly with a mock ToolContext.
 * Git tests use a real temp git repo. Browser tests mock the Playwright interface.
 */

import { GitTool } from '../tools/impl/git.js';
import { BrowserTool } from '../tools/impl/browser.js';
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── Mock ToolContext ────────────────────────────────────────────────────────

function makeMockContext(workspaceRoot: string) {
  return {
    sessionId: 'tool-tests-git-browser',
    workspaceRoot,
    identity: {
      name: 'Lodestone',
      soul: 'test soul',
      rules: 'test rules',
      heartbeat: 'test heartbeat',
      user: 'Tester',
    },
    memory: {
      async wikiWrite(): Promise<void> {},
      async wikiRead(): Promise<string | null> { return null; },
      async storeFact(): Promise<void> {},
      async recall(): Promise<[]> { return []; },
      async store(): Promise<void> {},
      async wikiSearch(): Promise<[]> { return []; },
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

// ─── Git test helpers ───────────────────────────────────────────────────────

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lodestone-git-test-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // Create initial commit
  await writeFile(join(dir, 'README.md'), '# Test Repo\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
  return dir;
}

async function createBranch(repo: string, name: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-b', name], { cwd: repo });
  await writeFile(join(repo, `${name}.txt`), `Content for ${name}\n`);
  await execFileAsync('git', ['add', '-A'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', `Add ${name} feature`], { cwd: repo });
  await execFileAsync('git', ['checkout', 'main'], { cwd: repo });
}

// ─── Browser mock helpers ───────────────────────────────────────────────────

function createMockPage() {
  return {
    goto: async (_url: string, _opts?: Record<string, unknown>): Promise<{ status: number }> => {
      return { status: 200 };
    },
    title: async (): Promise<string> => 'Mock Page Title',
    screenshot: async (_opts: Record<string, unknown>): Promise<Buffer> => {
      // Return a fake PNG buffer (minimal 1x1 pixel PNG)
      return Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);
    },
    click: async (_selector: string): Promise<void> => {},
    fill: async (_selector: string, _text: string): Promise<void> => {},
    $: (_selector: string): { textContent(): Promise<string | null> } | null => null,
    evaluate: async <T,>(_fn: string): Promise<T> => {
      // Mock evaluate that returns a bounding box for selector queries
      if (_fn.includes('querySelector')) {
        return { x: 0, y: 0, width: 100, height: 100 } as T;
      }
      return null as T;
    },
    setViewportSize: async (_opts: { width: number; height: number }): Promise<void> => {},
    close: async (): Promise<void> => {},
  };
}

// ─── Test runner ─────────────────────────────────────────────────────────────

async function runTest() {
  console.log('🔧 Lodestone Tool Tests (git: listBranches/merge/currentBranch, browser: screenshot)');
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

  // ─── Git Tests ────────────────────────────────────────────────────────────

  // ─── Test 1: currentBranch returns the active branch name ─────────────────

  await test('git currentBranch: returns branch name', async () => {
    const repo = await createTempRepo();
    try {
      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'currentBranch' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { branch: string };
      if (data.branch !== 'main') throw new Error(`Expected 'main', got '${data.branch}'`);
      console.log(`   → Current branch: ${data.branch}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 2: currentBranch on a feature branch ────────────────────────────

  await test('git currentBranch: returns feature branch name', async () => {
    const repo = await createTempRepo();
    try {
      await createBranch(repo, 'feature-1');
      await execFileAsync('git', ['checkout', 'feature-1'], { cwd: repo });

      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'currentBranch' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { branch: string };
      if (data.branch !== 'feature-1') throw new Error(`Expected 'feature-1', got '${data.branch}'`);
      console.log(`   → Current branch: ${data.branch}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 3: listBranches returns local and remote branches ───────────────

  await test('git listBranches: lists local branches', async () => {
    const repo = await createTempRepo();
    try {
      await createBranch(repo, 'feature-1');
      await createBranch(repo, 'feature-2');

      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'listBranches' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { local: Array<{ name: string }>; remote: Array<{ name: string }>; currentBranch: string };
      if (data.local.length < 3) throw new Error(`Expected at least 3 local branches, got ${data.local.length}`);
      const branchNames = data.local.map((b) => b.name);
      if (!branchNames.includes('main')) throw new Error('Missing main branch');
      if (!branchNames.includes('feature-1')) throw new Error('Missing feature-1 branch');
      if (!branchNames.includes('feature-2')) throw new Error('Missing feature-2 branch');
      console.log(`   → Local: ${data.local.length}, Remote: ${data.remote.length}, Current: ${data.currentBranch}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 4: listBranches identifies current branch ───────────────────────

  await test('git listBranches: marks current branch', async () => {
    const repo = await createTempRepo();
    try {
      await createBranch(repo, 'feature-1');
      await execFileAsync('git', ['checkout', 'feature-1'], { cwd: repo });

      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'listBranches' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { local: Array<{ name: string; current: boolean }>; currentBranch: string };
      if (data.currentBranch !== 'feature-1') throw new Error(`Expected currentBranch 'feature-1', got '${data.currentBranch}'`);
      const current = data.local.find((b) => b.name === 'feature-1');
      if (!current) throw new Error('feature-1 not found in local branches');
      if (!current.current) throw new Error('feature-1 should be marked as current');
      console.log(`   → Current: ${data.currentBranch}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 5: merge — merges a feature branch into main ─────────────────────

  await test('git merge: merges feature branch into current', async () => {
    const repo = await createTempRepo();
    try {
      await createBranch(repo, 'feature-1');

      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'merge', args: 'feature-1' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { mergedBranch: string; intoBranch: string; mode: string };
      if (data.mergedBranch !== 'feature-1') throw new Error(`Expected mergedBranch 'feature-1', got '${data.mergedBranch}'`);
      if (data.intoBranch !== 'main') throw new Error(`Expected intoBranch 'main', got '${data.intoBranch}'`);
      if (data.mode !== 'merge') throw new Error(`Expected mode 'merge', got '${data.mode}'`);

      // Verify the file was merged
      const files = await readFile(join(repo, 'feature-1.txt'), 'utf-8');
      if (!files.includes('feature-1')) throw new Error('Merged file content missing');
      console.log(`   → Merged '${data.mergedBranch}' into '${data.intoBranch}' (${data.mode})`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 6: merge — squash merge mode ─────────────────────────────────────

  await test('git merge: squash merge creates single commit', async () => {
    const repo = await createTempRepo();
    try {
      await createBranch(repo, 'feature-2');

      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'merge', args: 'feature-2', mergeMode: 'squash' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { mergedBranch: string; mode: string };
      if (data.mode !== 'squash') throw new Error(`Expected mode 'squash', got '${data.mode}'`);

      // Verify file was merged
      const content = await readFile(join(repo, 'feature-2.txt'), 'utf-8');
      if (!content.includes('feature-2')) throw new Error('Merged file content missing');
      console.log(`   → Squash merged '${data.mergedBranch}' (mode: ${data.mode})`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 7: merge — no-ff merge mode ──────────────────────────────────────

  await test('git merge: no-ff merge creates merge commit', async () => {
    const repo = await createTempRepo();
    try {
      await createBranch(repo, 'feature-3');

      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'merge', args: 'feature-3', mergeMode: 'no-ff' }, ctx);
      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { mergedBranch: string; mode: string };
      if (data.mode !== 'no-ff') throw new Error(`Expected mode 'no-ff', got '${data.mode}'`);

      // Verify file was merged
      const content = await readFile(join(repo, 'feature-3.txt'), 'utf-8');
      if (!content.includes('feature-3')) throw new Error('Merged file content missing');
      console.log(`   → No-ff merged '${data.mergedBranch}' (mode: ${data.mode})`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 8: merge — missing branch name fails gracefully ──────────────────

  await test('git merge: missing branch name fails gracefully', async () => {
    const repo = await createTempRepo();
    try {
      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      const result = await tool.execute({ operation: 'merge', args: '' }, ctx);
      if (result.success) throw new Error('Expected failure for missing branch name');
      if (!result.error?.includes('MissingBranch')) throw new Error(`Expected MissingBranch error, got: ${result.error}`);
      console.log(`   → Correctly rejected missing branch name`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Test 9: git error messages include operation context ─────────────────

  await test('git: error messages include operation name', async () => {
    const repo = await createTempRepo();
    try {
      const ctx = makeMockContext(repo);
      const tool = new GitTool();
      // Try to merge a nonexistent branch
      const result = await tool.execute({ operation: 'merge', args: 'nonexistent-branch' }, ctx);
      if (result.success) throw new Error('Expected failure for nonexistent branch');
      if (!result.error?.includes('merge')) throw new Error(`Error should mention 'merge': ${result.error}`);
      console.log(`   → Error includes operation context: ${result.error?.slice(0, 80)}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ─── Browser Tests ─────────────────────────────────────────────────────────

  // ─── Test 10: screenshot returns base64 data with format ──────────────────

  await test('browser screenshot: returns base64 data with format', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lodestone-browser-test-'));
    try {
      const ctx = makeMockContext(tmpDir);

      // Monkey-patch BrowserTool to use our mock page
      const tool = new BrowserTool();
      const mockPage = createMockPage();
      (BrowserTool as unknown as { state: { browser: unknown; page: unknown } }).state = {
        browser: { close: async () => {} },
        page: mockPage,
      };

      const result = await tool.execute({
        action: 'screenshot',
        format: 'png',
        fullPage: false,
      }, ctx);

      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { screenshot: string; format: string; fullPage: boolean };
      if (!data.screenshot?.startsWith('data:image/png;base64,')) throw new Error('Expected base64 PNG data');
      if (data.format !== 'png') throw new Error(`Expected format 'png', got '${data.format}'`);
      if (data.fullPage !== false) throw new Error(`Expected fullPage false, got ${data.fullPage}`);
      console.log(`   → Screenshot: ${data.screenshot.slice(0, 40)}... (format: ${data.format})`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Test 11: screenshot with jpeg format ─────────────────────────────────

  await test('browser screenshot: supports jpeg format', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lodestone-browser-test-'));
    try {
      const ctx = makeMockContext(tmpDir);
      const tool = new BrowserTool();
      const mockPage = createMockPage();
      (BrowserTool as unknown as { state: { browser: unknown; page: unknown } }).state = {
        browser: { close: async () => {} },
        page: mockPage,
      };

      const result = await tool.execute({
        action: 'screenshot',
        format: 'jpeg',
      }, ctx);

      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { screenshot: string; format: string };
      if (!data.screenshot?.startsWith('data:image/jpeg;base64,')) throw new Error('Expected base64 JPEG data');
      if (data.format !== 'jpeg') throw new Error(`Expected format 'jpeg', got '${data.format}'`);
      console.log(`   → JPEG screenshot: format=${data.format}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Test 12: screenshot with fullPage option ─────────────────────────────

  await test('browser screenshot: fullPage option', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lodestone-browser-test-'));
    try {
      const ctx = makeMockContext(tmpDir);
      const tool = new BrowserTool();
      const mockPage = createMockPage();
      (BrowserTool as unknown as { state: { browser: unknown; page: unknown } }).state = {
        browser: { close: async () => {} },
        page: mockPage,
      };

      const result = await tool.execute({
        action: 'screenshot',
        fullPage: true,
      }, ctx);

      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { fullPage: boolean };
      if (data.fullPage !== true) throw new Error(`Expected fullPage true, got ${data.fullPage}`);
      console.log(`   → Full page screenshot: fullPage=${data.fullPage}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Test 13: screenshot saves to file when saveTo is provided ─────────────

  await test('browser screenshot: saves to file when saveTo provided', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lodestone-browser-test-'));
    try {
      const ctx = makeMockContext(tmpDir);
      const tool = new BrowserTool();
      const mockPage = createMockPage();
      (BrowserTool as unknown as { state: { browser: unknown; page: unknown } }).state = {
        browser: { close: async () => {} },
        page: mockPage,
      };

      const savePath = join(tmpDir, 'test-screenshot.png');
      const result = await tool.execute({
        action: 'screenshot',
        saveTo: savePath,
      }, ctx);

      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { path: string };
      if (data.path !== savePath) throw new Error(`Expected path '${savePath}', got '${data.path}'`);
      // Verify file was actually written
      const content = await readFile(savePath);
      if (content.length === 0) throw new Error('Saved screenshot file is empty');
      console.log(`   → Saved to: ${data.path} (${content.length} bytes)`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Test 14: screenshot with selector clips to element ────────────────────

  await test('browser screenshot: selector targets element', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lodestone-browser-test-'));
    try {
      const ctx = makeMockContext(tmpDir);
      const tool = new BrowserTool();
      const mockPage = createMockPage();
      (BrowserTool as unknown as { state: { browser: unknown; page: unknown } }).state = {
        browser: { close: async () => {} },
        page: mockPage,
      };

      const result = await tool.execute({
        action: 'screenshot',
        selector: '#header',
      }, ctx);

      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { selector: string | null };
      if (data.selector !== '#header') throw new Error(`Expected selector '#header', got '${data.selector}'`);
      console.log(`   → Selector screenshot: ${data.selector}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Test 15: screenshot with custom viewport dimensions ─────────────────

  await test('browser screenshot: custom viewport dimensions', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lodestone-browser-test-'));
    try {
      const ctx = makeMockContext(tmpDir);
      const tool = new BrowserTool();
      const mockPage = createMockPage();
      (BrowserTool as unknown as { state: { browser: unknown; page: unknown } }).state = {
        browser: { close: async () => {} },
        page: mockPage,
      };

      const result = await tool.execute({
        action: 'screenshot',
        width: 1920,
        height: 1080,
      }, ctx);

      if (!result.success) throw new Error(`Tool failed: ${result.error}`);
      const data = result.data as { width: number; height: number };
      if (data.width !== 1920) throw new Error(`Expected width 1920, got ${data.width}`);
      if (data.height !== 1080) throw new Error(`Expected height 1080, got ${data.height}`);
      console.log(`   → Dimensions: ${data.width}x${data.height}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log('');
  console.log('═'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('');

  if (failed === 0) {
    console.log('🔧 All git/browser tool tests passed.');
  } else {
    console.log(`⚠️  ${failed} test(s) failed. See errors above.`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
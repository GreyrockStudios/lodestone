/**
 * Lodestone — Tool Tests for wiki-write, wiki-read, memory-store, memory-recall
 *
 * Tests the 4 newer tools directly with a mock ToolContext.
 * No real LLM or database needed — just verifies tool execute() behavior.
 */

import { WikiWriteTool } from '../tools/impl/wiki-write.js';
import { WikiReadTool } from '../tools/impl/wiki-read.js';
import { MemoryStoreTool } from '../tools/impl/memory-store.js';
import { MemoryRecallTool } from '../tools/impl/memory-recall.js';
import { resolve } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';

const WORKSPACE = '/tmp/lodestone-tool-tests/workspace';
const WIKI_ROOT = resolve(WORKSPACE, 'memory/wiki');

// ─── In-memory mock storage ─────────────────────────────────────────────────

interface MockMemoryResult {
  text: string;
  relevance: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

const storedFacts: Array<{ text: string; category: string; importance: number }> = [];
const memoryRecords: MockMemoryResult[] = [];

// ─── Mock ToolContext ────────────────────────────────────────────────────────

function makeMockContext() {
  return {
    sessionId: 'tool-tests',
    workspaceRoot: WORKSPACE,
    identity: {
      name: 'Lodestone',
      soul: 'test soul',
      rules: 'test rules',
      heartbeat: 'test heartbeat',
      user: 'Tester',
    },
    memory: {
      // wikiWrite — writes an actual .md file to disk
      async wikiWrite(slug: string, content: string, frontmatter?: Record<string, unknown>): Promise<void> {
        const dir = WIKI_ROOT;
        await mkdir(dir, { recursive: true });
        const fm = frontmatter || {};
        const fmLines = Object.entries(fm)
          .map(([k, v]) => {
            if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
            return `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
          })
          .join('\n');
        const page = `---\n${fmLines}\n---\n\n${content}\n`;
        await writeFile(resolve(dir, `${slug}.md`), page, 'utf-8');
      },

      // wikiRead — reads an .md file from disk
      async wikiRead(slug: string): Promise<string | null> {
        try {
          const content = await readFile(resolve(WIKI_ROOT, `${slug}.md`), 'utf-8');
          return content;
        } catch {
          return null;
        }
      },

      // storeFact — records in the in-memory array
      async storeFact(text: string, category: string, importance?: number): Promise<void> {
        storedFacts.push({ text, category, importance: importance ?? 0.7 });
        // Also add to memoryRecords so recall can find it
        memoryRecords.push({
          text,
          relevance: 0.1,
          timestamp: new Date().toISOString(),
          metadata: { category, importance: importance ?? 0.7 },
        });
      },

      // recall — searches the in-memory records
      async recall(query: string, limit?: number): Promise<MockMemoryResult[]> {
        const max = limit ?? 5;
        const lower = query.toLowerCase();
        const matches = memoryRecords.filter(r => r.text.toLowerCase().includes(lower));
        return matches.slice(0, max);
      },

      // store — simple in-memory store
      async store(key: string, value: string): Promise<void> {
        memoryRecords.push({
          text: `${key}: ${value}`,
          relevance: 0.1,
          timestamp: new Date().toISOString(),
          metadata: { key },
        });
      },

      // wikiSearch — basic stub
      async wikiSearch(query: string, limit?: number): Promise<Array<{ slug: string; title: string; excerpt: string; score: number }>> {
        return [];
      },

      // scratch buffer stubs
      async scratchGet(key: string): Promise<string | null> {
        return null;
      },
      async scratchSet(key: string, value: string, ttlMs?: number): Promise<void> {},
    },
    log: {
      info: (msg: string) => {},
      warn: (msg: string) => {},
      error: (msg: string) => {},
    },
  };
}

// ─── Test runner ─────────────────────────────────────────────────────────────

async function runTest() {
  console.log('🔧 Lodestone Tool Tests (wiki-write, wiki-read, memory-store, memory-recall)');
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
  await mkdir(WIKI_ROOT, { recursive: true });

  // ─── Test 1: wiki-write — write a wiki page ──────────────────────────────

  await test('wiki-write: write a wiki page', async () => {
    const ctx = makeMockContext();
    const tool = new WikiWriteTool();
    const result = await tool.execute(
      {
        slug: 'test-page',
        content: '# Test Page\n\nThis is a test page with [[wikilink]] syntax.',
        title: 'Test Page',
        tags: 'test, integration',
      },
      ctx,
    );
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as { slug: string; length: number };
    if (data.slug !== 'test-page') throw new Error('Expected slug to be test-page');

    // Verify file exists on disk
    const fileContent = await readFile(resolve(WIKI_ROOT, 'test-page.md'), 'utf-8');
    if (!fileContent.includes('Test Page')) throw new Error('File content missing title');
    if (!fileContent.includes('wikilink')) throw new Error('File content missing body');
    console.log(`   → Written ${fileContent.length} chars to test-page.md`);
  });

  // ─── Test 2: wiki-read — read the page back ───────────────────────────────

  await test('wiki-read: read the wiki page back', async () => {
    const ctx = makeMockContext();
    const tool = new WikiReadTool();
    const result = await tool.execute(
      { slug: 'test-page' },
      ctx,
    );
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    if (!result.data) throw new Error('Expected page content');
    const content = result.data as string;
    if (!content.includes('Test Page')) throw new Error('Content does not include title');
    if (!content.includes('wikilink')) throw new Error('Content does not include body');
    console.log(`   → Read back ${content.length} chars`);
  });

  // ─── Test 3: wiki-read — non-existent page returns null ───────────────────

  await test('wiki-read: non-existent page returns null', async () => {
    const ctx = makeMockContext();
    const tool = new WikiReadTool();
    const result = await tool.execute(
      { slug: 'does-not-exist' },
      ctx,
    );
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    if (result.data !== null) throw new Error(`Expected null, got: ${result.data}`);
    console.log(`   → Correctly returned null for missing page`);
  });

  // ─── Test 4: memory-store — store a fact ─────────────────────────────────

  await test('memory-store: store a fact', async () => {
    const ctx = makeMockContext();
    const tool = new MemoryStoreTool();
    const result = await tool.execute(
      {
        text: 'TypeScript is the best language for AI tooling',
        category: 'fact',
        importance: 0.9,
      },
      ctx,
    );
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const storeData = result.data as { text: string; category: string; importance: number };
    if (storeData.category !== 'fact') throw new Error('Expected category to be fact');
    if (storeData.importance !== 0.9) throw new Error('Expected importance 0.9');

    // Verify it was stored via storeFact
    if (storedFacts.length !== 1) throw new Error(`Expected 1 stored fact, got ${storedFacts.length}`);
    if (storedFacts[0].text !== 'TypeScript is the best language for AI tooling')
      throw new Error('Stored fact text mismatch');
    console.log(`   → Stored fact: "${storedFacts[0].text.slice(0, 50)}..."`);
  });

  // ─── Test 5: memory-store — missing text fails ─────────────────────────────

  await test('memory-store: empty text fails gracefully', async () => {
    const ctx = makeMockContext();
    const tool = new MemoryStoreTool();
    const result = await tool.execute(
      { text: '', category: 'fact' },
      ctx,
    );
    if (result.success) throw new Error('Expected failure for empty text');
    if (!result.error && !result.summary.includes('Error')) throw new Error('Expected error summary');
    console.log(`   → Correctly rejected empty text`);
  });

  // ─── Test 6: memory-recall — recall memories ───────────────────────────────

  await test('memory-recall: recall stored memories', async () => {
    const ctx = makeMockContext();
    const tool = new MemoryRecallTool();
    const result = await tool.execute(
      {
        query: 'TypeScript',
        limit: 5,
      },
      ctx,
    );
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as MockMemoryResult[];
    if (!Array.isArray(data)) throw new Error('Expected array result');
    if (data.length === 0) throw new Error('Expected at least 1 result');
    if (!data[0].text.includes('TypeScript')) throw new Error('Result does not include query term');
    console.log(`   → Found ${data.length} memory result(s)`);
  });

  // ─── Test 7: memory-recall — no results returns empty array ──────────────

  await test('memory-recall: no matches returns empty', async () => {
    const ctx = makeMockContext();
    const tool = new MemoryRecallTool();
    const result = await tool.execute(
      { query: 'nonexistent-xyz-query' },
      ctx,
    );
    if (!result.success) throw new Error(`Tool failed: ${result.error}`);
    const data = result.data as unknown[];
    if (!Array.isArray(data)) throw new Error('Expected array result');
    if (data.length !== 0) throw new Error(`Expected 0 results, got ${data.length}`);
    console.log(`   → Correctly returned empty results`);
  });

  // ─── Test 8: wiki-write — missing slug fails ─────────────────────────────

  await test('wiki-write: missing slug fails gracefully', async () => {
    const ctx = makeMockContext();
    const tool = new WikiWriteTool();
    const result = await tool.execute(
      { slug: '', content: 'some content' },
      ctx,
    );
    if (result.success) throw new Error('Expected failure for empty slug');
    console.log(`   → Correctly rejected empty slug`);
  });

  // ─── Summary ──────────────────────────────────────────────────────────────

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

runTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
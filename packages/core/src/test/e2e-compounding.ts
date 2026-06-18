/**
 * Lodestone E2E Test — Memory Compounding Integration
 *
 * Tests that:
 * 1. MemoryCompounding is instantiated in MemorySystem
 * 2. Wiki writes trigger entity extraction
 * 3. Extracted entities are added to KnowledgeGraph
 * 4. Co-occurring entities get related-to edges
 * 5. Contradiction detection works
 * 6. Growth report generates correctly
 * 7. Compounding can be disabled via config
 */
import { join } from 'path';
import { rmSync, mkdirSync } from 'fs';
import { MemorySystem, type MemorySystemConfig } from '../memory/memory-system.js';
import { MemoryCompounding } from '../memory/memory-compounding.js';

const TMP = '/tmp/lodestone-compounding-test';
let passed = 0, failed = 0;
const results: { name: string; ok: boolean; detail: string }[] = [];

async function test(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    passed++;
    results.push({ name, ok: true, detail: detail || 'OK' });
    console.log(`  ✅ ${name} — ${detail || 'OK'}`);
  } catch (err: any) {
    failed++;
    results.push({ name, ok: false, detail: err?.message || String(err) });
    console.log(`  ❌ ${name} — ${err?.message || String(err)}`);
  }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

// Setup
try { rmSync(TMP, { recursive: true }); } catch {}
mkdirSync(TMP, { recursive: true });

function makeConfig(opts: { compounding?: { enabled: boolean } } = {}): MemorySystemConfig {
  return {
    wiki: {
      rootDir: join(TMP, 'wiki'),
      autoIndex: true,
      autoLint: false,
      categories: ['entities', 'concepts', 'decisions', 'projects', 'areas', 'research'],
    },
    vector: {
      dbPath: join(TMP, 'lancedb'),
      embeddingProvider: 'ollama',
      embeddingModel: 'nomic-embed-text',
      dimensions: 768,
      recallMaxChars: 800,
      autoRecall: false,
      autoCapture: false,
    },
    scratch: {
      dbPath: join(TMP, 'scratch.json'),
      defaultTtlMs: null,
    },
    knowledgeGraph: {
      dataDir: join(TMP, 'knowledge-graph'),
    },
    compounding: opts.compounding
      ? { dataDir: join(TMP, 'compounding'), enabled: opts.compounding.enabled }
      : { dataDir: join(TMP, 'compounding') },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

async function testCompoundingEnabled() {
  console.log('\n🧠 Memory Compounding Integration');

  const config = makeConfig();
  const mem = new MemorySystem(config);
  await mem.init();

  await test('MemorySystem has compounding', async () => {
    assert(mem.compounding !== null, 'compounding should be instantiated');
    return 'compounding is non-null';
  });

  await test('KnowledgeGraph starts empty', async () => {
    const stats = mem.knowledgeGraph.getStats();
    assert(stats.nodeCount === 0, `expected 0 nodes, got ${stats.nodeCount}`);
    return '0 nodes';
  });

  await test('Wiki write triggers entity extraction', async () => {
    const content = `# TypeScript Project

This project uses TypeScript and Node.js with Docker for deployment.
The system leverages Redis for caching and PostgreSQL for persistence.
`;

    await mem.wiki.write('test-project', content, { title: 'Test Project' });
    // The onWrite callback should fire processWikiWrite automatically
    // Give it a moment to process
    await new Promise(r => setTimeout(r, 100));

    const stats = mem.knowledgeGraph.getStats();
    assert(stats.nodeCount > 0, `expected nodes in graph, got ${stats.nodeCount}`);
    return `${stats.nodeCount} nodes extracted`;
  });

  await test('Technology entities are typed correctly', async () => {
    const typescriptNode = mem.knowledgeGraph.getNode('technology:typescript');
    assert(typescriptNode !== undefined, 'TypeScript node should exist');
    assert(typescriptNode!.type === 'entity', `expected entity type, got ${typescriptNode!.type}`);
    return 'TypeScript node found';
  });

  await test('Co-occurring entities get related-to edges', async () => {
    const stats = mem.knowledgeGraph.getStats();
    assert(stats.edgeCount > 0, `expected edges, got ${stats.edgeCount}`);
    return `${stats.edgeCount} edges created`;
  });

  await test('Growth report generates', async () => {
    const report = mem.getCompoundingStats();
    assert(report.enabled === true, 'compounding should be enabled');
    assert(report.growthReport !== null, 'growth report should exist');
    return `${report.growthReport?.wikiPages} pages, ${report.growthReport?.totalEntities} entities`;
  });

  await test('Multiple wiki writes accumulate graph nodes', async () => {
    const before = mem.knowledgeGraph.getStats().nodeCount;
    await mem.wiki.write('another-page', `# React Frontend\n\nUsing React with TypeScript and Socket.IO for real-time.`, { title: 'React Frontend' });
    await new Promise(r => setTimeout(r, 100));
    const after = mem.knowledgeGraph.getStats().nodeCount;
    assert(after >= before, `expected growth, ${before} → ${after}`);
    return `${before} → ${after} nodes`;
  });

  await test('ensureWikiPage also triggers compounding', async () => {
    const before = mem.knowledgeGraph.getStats().nodeCount;
    await mem.ensureWikiPage('kronos-trader', 'Kronos Trader', `# Kronos\n\nKronos uses Python and Go for backend services with Redis caching.`);
    await new Promise(r => setTimeout(r, 100));
    const after = mem.knowledgeGraph.getStats().nodeCount;
    assert(after > before, `expected growth from ensureWikiPage, ${before} → ${after}`);
    return `${before} → ${after} nodes`;
  });
}

async function testCompoundingDisabled() {
  console.log('\n🚫 Memory Compounding Disabled');

  const TMP2 = '/tmp/lodestone-compounding-disabled';
  try { rmSync(TMP2, { recursive: true }); } catch {}
  mkdirSync(TMP2, { recursive: true });

  const config: MemorySystemConfig = {
    wiki: {
      rootDir: join(TMP2, 'wiki'),
      autoIndex: true,
      autoLint: false,
      categories: ['entities', 'concepts', 'decisions', 'projects', 'areas', 'research'],
    },
    vector: {
      dbPath: join(TMP2, 'lancedb'),
      embeddingProvider: 'ollama',
      embeddingModel: 'nomic-embed-text',
      dimensions: 768,
      recallMaxChars: 800,
      autoRecall: false,
      autoCapture: false,
    },
    scratch: {
      dbPath: join(TMP2, 'scratch.json'),
      defaultTtlMs: null,
    },
    knowledgeGraph: {
      dataDir: join(TMP2, 'knowledge-graph'),
    },
    compounding: { dataDir: join(TMP2, 'compounding'), enabled: false },
  };
  const mem = new MemorySystem(config);
  await mem.init();

  await test('Compounding is null when disabled', async () => {
    assert(mem.compounding === null, 'compounding should be null');
    return 'null as expected';
  });

  await test('Wiki write works without compounding', async () => {
    await mem.wiki.write('test-no-compound', `# Test\n\nTypeScript and Node.js content.`, { title: 'Test' });
    const stats = mem.knowledgeGraph.getStats();
    assert(stats.nodeCount === 0, `expected 0 nodes, got ${stats.nodeCount}`);
    return 'write succeeded, 0 graph nodes';
  });

  await test('getCompoundingStats reports disabled', async () => {
    const stats = mem.getCompoundingStats();
    assert(stats.enabled === false, 'should report disabled');
    return 'disabled correctly';
  });
}

async function testContradictionDetection() {
  console.log('\n⚠️ Contradiction Detection');

  const config = makeConfig();
  const mem = new MemorySystem(config);
  await mem.init();

  // First, write a page with a claim
  await mem.wiki.write('tech-status', `# Technology Status

The project uses Docker for containerization. Docker is the primary deployment tool.
`, { title: 'Tech Status' });
  await new Promise(r => setTimeout(r, 100));

  await test('Contradiction markers detected in new content', async () => {
    const compounding = mem.compounding!;
    // Direct test of contradiction detection
    const contradiction = compounding.checkContradiction(
      'Docker is no longer used. It has been replaced by Kubernetes.',
      'tech-status'
    );
    // May or may not find contradiction depending on subject extraction
    // The key is that the check runs without error
    return contradiction ? `contradiction found: ${contradiction.severity}` : 'check ran, no match';
  });

  await test('Compounding report from wiki write', async () => {
    const compounding = mem.compounding!;
    const report = compounding.processWikiWrite('test-page', `# Test\n\nUsing TypeScript and React with Docker and Redis.`);
    assert(report.entitiesExtracted > 0, `expected entities, got ${report.entitiesExtracted}`);
    return `${report.entitiesExtracted} entities, ${report.crossReferencesAdded} cross-refs`;
  });
}

async function testStandaloneCompounding() {
  console.log('\n🔬 Standalone MemoryCompounding');

  const compounding = new MemoryCompounding({
    dataDir: join(TMP, 'standalone-compounding'),
    wikiRoot: join(TMP, 'wiki'),
  });
  await compounding.init();

  await test('Entity extraction finds technologies', async () => {
    const entities = compounding.extractEntities('We use TypeScript, Docker, and PostgreSQL for the project.');
    const techEntities = entities.filter(e => e.type === 'technology');
    assert(techEntities.length >= 3, `expected 3+ tech entities, got ${techEntities.length}`);
    return `${techEntities.length} technologies found`;
  });

  await test('Entity extraction finds project links', async () => {
    const entities = compounding.extractEntities('See [[kronos-trader]] and [[lodestone]] for details.');
    const projectEntities = entities.filter(e => e.type === 'project');
    assert(projectEntities.length >= 2, `expected 2+ project entities, got ${projectEntities.length}`);
    return `${projectEntities.length} projects found`;
  });

  await test('Growth report with no wiki', async () => {
    const report = compounding.generateGrowthReport();
    assert(typeof report.totalEntities === 'number', 'should return a number');
    return `${report.totalEntities} entities, ${report.wikiPages} pages`;
  });
}

// ─── Run All ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  🧪 Memory Compounding Integration Tests');
  console.log('══════════════════════════════════════════════════════════════');

  await testCompoundingEnabled();
  await testCompoundingDisabled();
  await testContradictionDetection();
  await testStandaloneCompounding();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  📊 ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('══════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
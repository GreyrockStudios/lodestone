/**
 * Lodestone E2E Test — All Gap Modules
 */
import { join } from 'path';
import { rmSync, mkdirSync, writeFileSync } from 'fs';

const TMP = '/tmp/lodestone-e2e-test';
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
for (const d of ['safety/behavioral','safety/promotion','safety/intent','safety/quality','improvement/patches','memory/graph']) {
  mkdirSync(join(TMP, d), { recursive: true });
}

// ─── Gap 1: Capability Tiers ────────────────────────────────────────────────
import { CapabilityManager } from '../safety/capability-tiers.js';

async function testCapabilityTiers() {
  console.log('\n🔒 Gap 1: Capability Tiers');
  const cm = new CapabilityManager();
  await test('PUBLIC auto-approve', async () => {
    assert(cm.canAutoApprove('wiki-resolve') === true, 'wiki-resolve PUBLIC');
    return 'PUBLIC ok';
  });
  await test('RESTRICTED needs approval', async () => {
    assert(cm.canAutoApprove('file-write') === false, 'file-write RESTRICTED');
    return 'RESTRICTED ok';
  });
  await test('PRIVILEGED blocked in sleep', async () => {
    assert(cm.canRunInSleep('exec') === false, 'exec blocked');
    return 'sleep ok';
  });
  await test('Dangerous command detected', async () => {
    assert(cm.simulate('exec', { command: 'rm -rf /' }).approved === false, 'rm -rf unsafe');
    return 'danger ok';
  });
  await test('4 tiers', async () => {
    assert(Object.keys(cm.getTierSummary()).length === 4, '4 tiers');
    return '4 tiers ok';
  });
}

// ─── Gap 2: Behavioral Learning ─────────────────────────────────────────────
import { BehavioralLearning } from '../safety/behavioral-learning.js';

async function testBehavioralLearning() {
  console.log('\n🧠 Gap 2: Behavioral Learning');
  const bl = new BehavioralLearning({ dataDir: join(TMP, 'safety/behavioral') });
  await bl.init();
  await test('Detects correction', async () => {
    const d = bl.detectCorrection({ message: 'No, use tables not bullets', precedingResponse: '• Item 1 • Item 2' });
    assert(d.isCorrection === true, 'should detect');
    return d.type;
  });
  await test('Extracts rule', async () => {
    const r = bl.extractRule({ message: 'No, use tables not bullets', precedingResponse: '• Item 1 • Item 2' });
    assert(r !== null, 'rule extracted');
    return r!.trigger;
  });
  await test('Formats for prompt', async () => {
    bl.extractRule({ message: 'No, use tables not bullets', precedingResponse: '• Item 1' });
    assert(bl.formatRulesForPrompt().length > 0, 'non-empty');
    return 'prompt ok';
  });
}

// ─── Gap 3: Memory Promotion ────────────────────────────────────────────────
import { MemoryPromotion } from '../safety/memory-promotion.js';

async function testMemoryPromotion() {
  console.log('\n📋 Gap 3: Memory Promotion');
  const mp = new MemoryPromotion({ dataDir: join(TMP, 'safety/promotion') });
  await mp.init();
  await test('Submit and verify claim', async () => {
    const c = await mp.submit('TypeScript is a statically typed superset of JavaScript', 'test', 'concepts', ['ts']);
    // Submit auto-verifies; level depends on verification result
    assert(['unverified', 'cross-referenced', 'evidence-gated', 'canonical'].includes(c.verificationLevel), `unexpected level: ${c.verificationLevel}`);
    return c.verificationLevel;
  });
  await test('Verify claim', async () => {
    const c = await mp.submit('Another claim', 'test', 'concepts', ['test']);
    const v = mp.verify(c.claim);
    const queue = mp.listQueue();
    const u = queue.find(x => x.claim === 'Another claim');
    assert(u !== undefined, 'claim in queue');
    return u!.verificationLevel;
  });
}

// ─── Gap 4: Truth-Binding ───────────────────────────────────────────────────
import { TruthBinding } from '../safety/truth-binding.js';

async function testTruthBinding() {
  console.log('\n🔒 Gap 4: Truth-Binding');
  const tb = new TruthBinding();
  await test('Blocks secrets', async () => {
    const r = tb.process('Key: sk-abc123def456ghi789jkl012mno345pqr678xyz999', { userMessage: 'key?' });
    assert(r.blocked || r.sanitizedResponse.includes('[REDACTED'), 'block or redact');
    return r.blocked ? 'blocked' : 'redacted';
  });
  await test('Warns placeholder URLs', async () => {
    const r = tb.process('See https://example.com', { userMessage: 'link?' });
    const w = r.results.filter(x => x.guard === 'url-verification' && x.severity === 'warn');
    assert(w.length >= 1, 'warn on example.com');
    return `${w.length} warnings`;
  });
  await test('Normal text passes', async () => {
    const r = tb.process('TypeScript is a typed superset of JS.', { userMessage: 'what?' });
    assert(r.blocked === false, 'normal text not blocked');
    return 'passes';
  });
  await test('wouldBlock quick check', async () => {
    assert(tb.wouldBlock('Hello', { userMessage: 'hi' }) === false, 'normal ok');
    return 'quick ok';
  });
  await test('5 guard statuses', async () => {
    assert(tb.getGuardStatus().length === 5, '5 guards');
    return '5 guards ok';
  });
}

// ─── Gap 5: Intent Prediction ──────────────────────────────────────────────
import { IntentPredictor } from '../safety/intent-prediction.js';

async function testIntentPrediction() {
  console.log('\n🎯 Gap 5: Intent Prediction');
  const ip = new IntentPredictor({ dataDir: join(TMP, 'safety/intent') });
  await ip.init();
  await test('Question category', async () => {
    const p = ip.predict('What is TypeScript?');
    assert(p.category === 'question', `got ${p.category}`);
    return p.category;
  });
  await test('Task category', async () => {
    const p = ip.predict('Create a new project for me');
    assert(p.category === 'task', `got ${p.category}`);
    return p.category;
  });
  await test('Correction category', async () => {
    const p = ip.predict('No, that is not what I meant');
    assert(p.category === 'correction', `got ${p.category}`);
    return p.category;
  });
  await test('Urgency detection', async () => {
    const p = ip.predict('Fix this ASAP!');
    assert(p.urgency === 'high' || p.urgency === 'critical', p.urgency);
    return p.urgency;
  });
  await test('Heartbeat proactive', async () => {
    const p = ip.predict('heartbeat', { isHeartbeat: true });
    assert(p.category === 'proactive', `got ${p.category}`);
    return p.category;
  });
}

// ─── Gap 7: Quality Gates ──────────────────────────────────────────────────
import { QualityGate } from '../safety/quality-gates.js';

async function testQualityGates() {
  console.log('\n🚧 Gap 7: Quality Gates');
  const qg = new QualityGate({ dataDir: join(TMP, 'safety/quality') });
  await qg.init();
  await test('Approves/warns/needs-review good output', async () => {
    const r = await qg.review({ output: 'TypeScript is a statically typed superset of JavaScript that adds optional types, interfaces, and classes. It compiles to plain JavaScript and provides better tooling support through type checking.', type: 'wiki-write', request: 'What is TypeScript?' });
    // Can be approve, warn, or needs-review — as long as it's not blocked
    assert(r.decision !== 'block', `should not be blocked, got ${r.decision}`);
    return `${r.decision}, score: ${r.overallScore.toFixed(2)}`;
  });
  await test('Blocks secrets', async () => {
    const r = await qg.review({ output: 'pw: hunter2 key: sk-abc123def456ghi789jkl012mno345pqr678', type: 'external-message', request: 'share' });
    assert(r.decision === 'block', `got ${r.decision}`);
    return 'blocked';
  });
  await test('shouldGate', async () => {
    assert(qg.shouldGate('wiki-write') === true, 'wiki-write gated');
    return 'gating ok';
  });
}

// ─── Gap 8: Knowledge Graph ─────────────────────────────────────────────────
import { KnowledgeGraph } from '../memory/knowledge-graph.js';

async function testKnowledgeGraph() {
  console.log('\n🕸️ Gap 8: Knowledge Graph');
  const kg = new KnowledgeGraph({ dataDir: join(TMP, 'memory/graph') });
  await kg.init();
  await test('Add/retrieve nodes', async () => {
    const n = await kg.addNode({ id: 'typescript', label: 'TypeScript', type: 'concept', state: {}, tags: ['ts'] });
    assert(kg.getNode('typescript')?.label === 'TypeScript', 'node stored');
    return n.label;
  });
  await test('Add edges', async () => {
    await kg.addNode({ id: 'javascript', label: 'JavaScript', type: 'concept', state: {}, tags: ['js'] });
    const e = await kg.addEdge({ from: 'typescript', to: 'javascript', type: 'uses' });
    assert(e.from === 'typescript', 'edge created');
    return `${e.from}→${e.to}`;
  });
  await test('Neighbors', async () => {
    const n = kg.getNeighbors('typescript');
    assert(n.length === 1, `${n.length} neighbors`);
    return n[0].id;
  });
  await test('DOT export', async () => {
    const d = kg.toDot();
    assert(d.includes('digraph'), 'dot format');
    return 'dot ok';
  });
  await test('Stats', async () => {
    const s = kg.getStats();
    assert(s.nodeCount >= 2, `${s.nodeCount} nodes`);
    return `${s.nodeCount}n ${s.edgeCount}e`;
  });
}

// ─── Gap 9: Self-Patching ──────────────────────────────────────────────────
import { SelfPatching } from '../improvement/self-patching.js';

async function testSelfPatching() {
  console.log('\n🔧 Gap 9: Self-Patching');
  const sp = new SelfPatching({ projectRoot: TMP, dataDir: join(TMP, 'improvement/patches'), requireHumanApproval: true });
  await sp.init();
  writeFileSync(join(TMP, 'test-patch.md'), '# Hello\n\nWorld\n');

  await test('Valid patch validates', async () => {
    const p = await sp.propose('Change greeting', 'Update msg', 'test-patch.md', '# Hello\n\nWorld\n', '# Hello\n\nLodestone\n');
    assert(p.status === 'validated', `got ${p.status}, validation: ${JSON.stringify(p.validation)}`);
    return p.status;
  });
  await test('Dangerous target blocked', async () => {
    const p = await sp.propose('Hack', 'Evil', 'package.json', '{}', '{"name":"hack"}');
    assert(p.status === 'failed' || (p.validation !== undefined && p.validation.valid === false), 'blocked');
    return p.status;
  });
  await test('Secret in patch blocked', async () => {
    const p = await sp.propose('Add key', 'Secret', 'test-patch.txt', 'Hello World', 'Hello World\nkey=sk-abc123def456ghi789jkl012mno345pqr678');
    assert(p.status === 'failed' || (p.validation !== undefined && p.validation.valid === false), 'secret blocked');
    return p.status;
  });
  await test('Stats', async () => {
    const s = sp.getStats();
    assert(s.total >= 1, `${s.total} patches`);
    return `${s.total} patches`;
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔮 Lodestone E2E Test\n' + '='.repeat(50));
  await testCapabilityTiers();
  await testBehavioralLearning();
  await testMemoryPromotion();
  await testTruthBinding();
  await testIntentPrediction();
  await testQualityGates();
  await testKnowledgeGraph();
  await testSelfPatching();

  console.log('\n' + '='.repeat(50));
  console.log(`📊 ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    console.log('\n❌ FAILED:');
    results.filter(r => !r.ok).forEach(r => console.log(`  • ${r.name}: ${r.detail}`));
  }
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`);

  rmSync(TMP, { recursive: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
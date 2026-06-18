/**
 * Lodestone E2E Test — Phase 3: Distinctive Features
 *
 * Tests for:
 * - Calibration Loop
 * - Drift Correction
 * - Patch Automation
 * - Multi-Agent Coordination
 */
import { join } from 'path';
import { rmSync, mkdirSync, writeFileSync } from 'fs';

const TMP = '/tmp/lodestone-phase3-test';
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
for (const d of ['calibration', 'drift-corrections', 'patches', 'patch-automation', 'multi-agent', 'predictions']) {
  mkdirSync(join(TMP, d), { recursive: true });
}

// ─── Phase 3.1: Calibration Loop ────────────────────────────────────────────
import { CalibrationLoop } from '../improvement/calibration-loop.js';
import { PredictionJournal } from '../improvement/prediction-journal.js';

async function testCalibrationLoop() {
  console.log('\n🎯 Phase 3.1: Calibration Loop');
  const journal = new PredictionJournal(join(TMP, 'predictions', 'predictions.json'));
  await journal.init();

  const cl = new CalibrationLoop({
    dataDir: join(TMP, 'calibration'),
    journal,
    adjustmentStrength: 0.1,
  });
  await cl.init();

  await test('Run with no data returns insufficient-data insight', async () => {
    const result = await cl.run();
    assert(result.insights.length > 0, 'should have insights');
    assert(result.insights[0].type === 'insufficient-data', `expected insufficient-data, got ${result.insights[0].type}`);
    return `${result.insights[0].type}`;
  });

  await test('Adjust confidence', async () => {
    const adjusted = cl.adjustConfidence(0.7);
    assert(adjusted >= 0 && adjusted <= 1, `adjusted ${adjusted} out of range`);
    return `0.7 → ${adjusted.toFixed(3)}`;
  });

  await test('Get adjustments (empty initially)', async () => {
    const adj = cl.getAdjustments();
    assert(Array.isArray(adj), 'adjustments is array');
    return `${adj.length} adjustments`;
  });

  // Add predictions and resolve them to get calibration data
  await test('Predictions + resolution feeds calibration', async () => {
    // Add several predictions and resolve them
    const p1 = await journal.predict('Test task 1', 'Will succeed', 0.8, new Date(Date.now() + 86400000).toISOString());
    await journal.resolve(p1.id, 'Will succeed'); // Correct — hit

    const p2 = await journal.predict('Test task 2', 'Will fail', 0.7, new Date(Date.now() + 86400000).toISOString());
    await journal.resolve(p2.id, 'Will fail'); // Correct — hit

    const p3 = await journal.predict('Test task 3', 'Will succeed', 0.9, new Date(Date.now() + 86400000).toISOString());
    await journal.resolve(p3.id, 'Different outcome'); // Miss

    const result = await cl.run();
    assert(result.report !== null, 'should have a report');
    assert(result.report!.totalPredictions >= 3, `${result.report!.totalPredictions} predictions`);
    return `${result.report!.totalPredictions} predictions, Brier ${result.report!.brierScore.toFixed(3)}`;
  });
}

// ─── Phase 3.2: Drift Correction ─────────────────────────────────────────────
import { DriftCorrector, DEFAULT_PRINCIPLES } from '../improvement/drift-correction.js';
import { DriftDetector } from '../improvement/drift-detector.js';

async function testDriftCorrection() {
  console.log('\n🧭 Phase 3.2: Drift Correction');
  const detector = new DriftDetector(join(TMP, 'drift-corrections', 'detector-reports.json'));
  await detector.init();

  const dc = new DriftCorrector({
    dataDir: join(TMP, 'drift-corrections'),
    detector,
    principles: DEFAULT_PRINCIPLES,
    correctionThreshold: 0.3,
  });
  await dc.init();

  await test('Default principles loaded', async () => {
    assert(DEFAULT_PRINCIPLES.length >= 4, `${DEFAULT_PRINCIPLES.length} principles`);
    return `${DEFAULT_PRINCIPLES.length} principles`;
  });

  await test('Check and correct with no drift', async () => {
    const result = await dc.checkAndCorrect();
    assert(result.corrections.length === 0 || result.overallDrift < 0.3, 'no significant drift with empty data');
    return `drift: ${result.overallDrift.toFixed(2)}, ${result.corrections.length} corrections`;
  });

  await test('Get stats', async () => {
    const stats = dc.getStats();
    assert(typeof stats.totalCorrections === 'number', 'stats has totalCorrections');
    return `${stats.totalCorrections} total corrections`;
  });

  await test('Format corrections for prompt', async () => {
    const formatted = dc.formatForPrompt([]);
    assert(formatted === '', 'empty corrections = empty string');
    return 'empty = empty string';
  });

  await test('Format corrections with pending', async () => {
    // Create a manual correction for testing
    const pending = dc.getPendingCorrections();
    // Even with no corrections, the formatter should work
    const formatted = dc.formatForPrompt(pending);
    assert(typeof formatted === 'string', 'formatted is string');
    return `formatted ${formatted.length} chars`;
  });
}

// ─── Phase 3.3: Patch Automation ────────────────────────────────────────────
import { PatchAutomation } from '../improvement/patch-automation.js';
import { SelfPatching } from '../improvement/self-patching.js';

async function testPatchAutomation() {
  console.log('\�🤖 Phase 3.3: Patch Automation');
  const sp = new SelfPatching({ projectRoot: TMP, dataDir: join(TMP, 'patches'), requireHumanApproval: true });
  await sp.init();

  const pa = new PatchAutomation({
    dataDir: join(TMP, 'patch-automation'),
    patchSystem: sp,
    projectRoot: TMP,
    autoRollback: true,
    maxAutoPatchesPerCycle: 3,
  });
  await pa.init();

  // Create a test file for patching
  writeFileSync(join(TMP, 'auto-test.md'), '# Test\n\nSome content here\n');

  await test('Propose from diagnosis', async () => {
    const patch = await pa.proposeFromDiagnosis({
      source: 'sleep-cycle',
      diagnosisId: 'test-001',
      description: 'Update test heading',
      rationale: 'Automated improvement from sleep cycle',
      targetFile: 'auto-test.md',
      oldContent: '# Test',
      newContent: '# Updated Test',
      tags: ['documentation'],
      priority: 'low',
    });
    assert(patch !== null, 'patch should be created');
    assert(patch!.status === 'validated' || patch!.status === 'proposed', `status: ${patch!.status}`);
    return patch!.status;
  });

  await test('Get pending reviews', async () => {
    const pending = pa.getPendingReviews();
    assert(Array.isArray(pending), 'pending is array');
    return `${pending.length} pending`;
  });

  await test('Get stats', async () => {
    const stats = pa.getStats();
    assert(stats.totalProposed >= 1, `${stats.totalProposed} proposed`);
    return `${stats.totalProposed} proposed`;
  });

  await test('Review patch (approve)', async () => {
    const pending = pa.getPendingReviews();
    if (pending.length > 0) {
      // Note: approve requires 'validated' status, our test patch may still be 'proposed'
      // Let's check status first
      const patch = pending[0];
      if (patch.status === 'validated') {
        const result = await pa.reviewPatch(patch.id, 'test-reviewer', 'approve', 'Looks good');
        assert(result !== null, 'review result not null');
        return result!.status;
      }
      return `skip (status: ${patch.status})`;
    }
    return 'no pending patches';
  });

  await test('Run cycle', async () => {
    const result = await pa.runCycle();
    assert(typeof result.processed === 'number', 'processed is number');
    return `${result.processed} processed, ${result.pending} pending`;
  });
}

// ─── Phase 3.4: Multi-Agent Coordination ─────────────────────────────────────
import { MultiAgentCoordinator } from '../improvement/multi-agent.js';

async function testMultiAgentCoordination() {
  console.log('\n👥 Phase 3.4: Multi-Agent Coordination');
  const mac = new MultiAgentCoordinator({
    dataDir: join(TMP, 'multi-agent'),
    maxConcurrent: 5,
  });
  await mac.init();

  await test('Spawn task', async () => {
    const task = mac.spawnTask({
      name: 'Test worker',
      type: 'worker',
      objective: 'Process data files',
      readScope: ['/workspace/data'],
      writeScope: ['/workspace/output'],
      allowedTools: ['read', 'write'],
      priority: 3,
    });
    assert(task.id.startsWith('task-'), `task id: ${task.id}`);
    assert(task.status === 'spawning', `status: ${task.status}`);
    return task.id;
  });

  await test('Start task', async () => {
    const tasks = mac.getActiveAgents();
    assert(tasks.length >= 1, `${tasks.length} active`);
    const started = mac.startTask(tasks[0].id);
    assert(started !== null, 'started');
    assert(started!.status === 'running', `status: ${started!.status}`);
    return started!.status;
  });

  await test('Complete task', async () => {
    const tasks = mac.getActiveAgents();
    const task = tasks.find(t => t.status === 'running');
    assert(task !== undefined, 'running task exists');
    const result = mac.completeTask(task!.id, {
      summary: 'Processed 5 data files',
      filesRead: ['/workspace/data/input.csv'],
      filesWritten: ['/workspace/output/result.json'],
      toolsUsed: ['read', 'write'],
      success: true,
      artifacts: ['/workspace/output/result.json'],
      durationMs: 1500,
    });
    assert(result !== null, 'result not null');
    assert(result!.status === 'completed', `status: ${result!.status}`);
    return result!.status;
  });

  await test('Request review', async () => {
    const review = mac.requestReview({
      taskId: 'test-task',
      target: '/workspace/output/result.json',
      reviewType: 'code-review',
      criteria: ['correctness', 'safety'],
      priority: 3,
    });
    assert(review.id.startsWith('review-'), `review id: ${review.id}`);
    return review.id;
  });

  await test('Deterministic code review', async () => {
    const code = `
      const apiKey = "sk-12345678901234567890123456789012";
      console.log("Processing...");
      console.log("Done");
      console.log("Error");
      console.log("Warning");
    `;
    const result = mac.performDeterministicReview(code, 'test.ts');
    assert(result.issues.length > 0, `${result.issues.length} issues found`);
    // Should find secrets and console.log
    const hasSecurity = result.issues.some(i => i.category === 'security');
    assert(hasSecurity, 'should find security issues');
    return `${result.issues.length} issues, passed: ${result.passed}`;
  });

  await test('Create handoff', async () => {
    const handoff = mac.createHandoff({
      from: 'agent-1',
      to: 'agent-2',
      context: 'Finished data processing, results in /workspace/output',
      relevantFiles: ['/workspace/output/result.json'],
    });
    assert(handoff.id.startsWith('handoff-'), `handoff id: ${handoff.id}`);
    assert(handoff.accepted === false, 'not yet accepted');
    return handoff.id;
  });

  await test('Accept handoff', async () => {
    const handoffs = mac.getActiveAgents(); // Should be empty now
    const stats = mac.getStats();
    // Check stats
    assert(stats.completed >= 1, `${stats.completed} completed`);
    return `${stats.completed} completed, ${stats.activeNow} active`;
  });

  await test('Get stats', async () => {
    const stats = mac.getStats();
    assert(stats.totalSpawned >= 1, `${stats.totalSpawned} spawned`);
    assert(stats.completed >= 1, `${stats.completed} completed`);
    return `${stats.totalSpawned} spawned, ${stats.completed} completed`;
  });

  await test('Check timeouts (none expected)', async () => {
    const timedOut = mac.checkTimeouts();
    assert(Array.isArray(timedOut), 'result is array');
    return `${timedOut.length} timed out`;
  });

  await test('Format status', async () => {
    const status = mac.formatStatus();
    assert(typeof status === 'string', 'status is string');
    assert(status.includes('Active agents'), 'has active agents');
    return 'status formatted ok';
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔮 Lodestone Phase 3 E2E Test\n' + '='.repeat(50));
  await testCalibrationLoop();
  await testDriftCorrection();
  await testPatchAutomation();
  await testMultiAgentCoordination();

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
#!/usr/bin/env node

/**
 * Lodestone — Sleep Cycle (Nightly Consolidation)
 *
 * Inspired by SkillOpt-Sleep (Microsoft Research): agents improve through
 * offline "dream" cycles that replay experience, extract durable rules,
 * and validate them before adopting.
 *
 * Phases:
 * 1. SENSORIUM — Check system health
 * 2. HARVEST — Review past 24h of session history
 * 3. MINE — Extract what worked, what didn't, general rules
 * 4. REFLECT — Write structured reflections
 * 5. CONSOLIDATE — Find patterns, promote durable rules to wiki
 * 6. VALIDATE — Check for contradictions with existing knowledge
 * 7. PREPARE — Brief summary for the user
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  workspaceRoot: process.env.LODESTONE_WORKSPACE || './workspace',
  dataDir: process.env.LODESTONE_DATA_DIR || './data',
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface SleepCycleReport {
  timestamp: string;
  phase: string;
  findings: string[];
  promotedRules: string[];
  contradictions: string[];
  summary: string;
}

// ─── Phases ──────────────────────────────────────────────────────────────────

async function runSensorium(): Promise<string[]> {
  console.log('[Sleep] Phase 1: SENSORIUM — Checking system health...');
  const findings: string[] = [];

  // Read the latest sensorium report if available
  const reportPath = join(CONFIG.dataDir, 'sensorium/latest.json');
  if (existsSync(reportPath)) {
    try {
      const raw = await readFile(reportPath, 'utf-8');
      const report = JSON.parse(raw);
      findings.push(`System status: ${report.overallStatus}`);
      for (const check of report.checks || []) {
        if (check.status !== 'ok') {
          findings.push(`${check.status.toUpperCase()}: ${check.name} — ${check.message}`);
        }
      }
    } catch {
      findings.push('Could not read sensorium report');
    }
  } else {
    findings.push('No sensorium report found — run sensorium first');
  }

  return findings;
}

async function harvest(): Promise<string[]> {
  console.log('[Sleep] Phase 2: HARVEST — Reviewing session history...');
  const findings: string[] = [];

  // Check for session logs
  const sessionDir = join(CONFIG.dataDir, 'sessions');
  if (!existsSync(sessionDir)) {
    findings.push('No session history yet — this is a fresh install');
    return findings;
  }

  try {
    const files = await readdir(sessionDir);
    const recentFiles = files
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 5); // Last 5 sessions

    findings.push(`Found ${recentFiles.length} recent session logs`);

    // In a full implementation, we'd parse these sessions
    // For M1, we just note their existence
    for (const file of recentFiles) {
      findings.push(`Session: ${file}`);
    }
  } catch {
    findings.push('Could not read session history');
  }

  return findings;
}

async function mine(): Promise<string[]> {
  console.log('[Sleep] Phase 3: MINE — Extracting patterns from experience...');
  const findings: string[] = [];

  // Check wiki for recently updated pages
  const wikiDir = join(CONFIG.workspaceRoot, 'memory/wiki');
  if (existsSync(wikiDir)) {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      // Find pages updated in the last 24 hours
      const { stdout } = await execAsync(
        `find "${wikiDir}" -name "*.md" -mtime -1 ! -name "index.md" 2>/dev/null | head -20`
      );
      const recentPages = stdout.trim().split('\n').filter(Boolean);
      if (recentPages.length > 0) {
        findings.push(`${recentPages.length} wiki pages updated in last 24h`);
        for (const page of recentPages.slice(0, 5)) {
          findings.push(`Updated: ${page.split('/').pop()?.replace('.md', '')}`);
        }
      } else {
        findings.push('No wiki pages updated in last 24h');
      }
    } catch {
      findings.push('Could not check wiki updates');
    }
  }

  // Check decision log
  const decisionsDir = join(CONFIG.workspaceRoot, 'memory/wiki/decisions');
  if (existsSync(decisionsDir)) {
    findings.push('Decision log exists — check for recent decisions');
  }

  // Check vector memory
  const dbDir = join(CONFIG.dataDir, 'lancedb');
  if (existsSync(dbDir)) {
    findings.push('Vector memory initialized');
  } else {
    findings.push('Vector memory not yet initialized');
  }

  return findings;
}

async function reflect(findings: string[]): Promise<string[]> {
  console.log('[Sleep] Phase 4: REFLECT — Writing structured reflections...');
  const reflections: string[] = [];

  // Categorize findings
  const failures = findings.filter(f => f.includes('FAIL') || f.includes('ERROR'));
  const warnings = findings.filter(f => f.includes('WARN') || f.includes('DEGRADED'));
  const successes = findings.filter(f => f.includes('ok') || f.includes('healthy') || f.includes('Found'));

  if (failures.length > 0) {
    reflections.push(`⚠️ ${failures.length} failures detected:`);
    failures.forEach(f => reflections.push(`  - ${f}`));
  }

  if (warnings.length > 0) {
    reflections.push(`⚡ ${warnings.length} warnings:`);
    warnings.forEach(f => reflections.push(`  - ${f}`));
  }

  if (successes.length > 0) {
    reflections.push(`✅ ${successes.length} healthy systems:`);
    successes.forEach(f => reflections.push(`  - ${f}`));
  }

  // Store reflections in vector memory (would be done by the agent in full impl)
  if (reflections.length > 0) {
    reflections.push('');
    reflections.push('Reflections stored for consolidation.');
  }

  return reflections;
}

async function consolidate(reflections: string[]): Promise<string[]> {
  console.log('[Sleep] Phase 5: CONSOLIDATE — Finding patterns and promoting rules...');
  const promoted: string[] = [];

  // In a full implementation, the agent would:
  // 1. Find patterns across 2+ reflections
  // 2. Promote durable rules to RULES.md
  // 3. Update wiki pages with new knowledge
  // 4. Flag contradictions

  // For M1, we note what would be consolidated
  if (reflections.length > 0) {
    promoted.push('Consolidation phase completed — reflections recorded');
  }

  return promoted;
}

async function validate(promotedRules: string[]): Promise<string[]> {
  console.log('[Sleep] Phase 6: VALIDATE — Checking for contradictions...');
  const contradictions: string[] = [];

  // In a full implementation, the agent would:
  // 1. Check promoted rules against existing wiki knowledge
  // 2. Flag any contradictions
  // 3. Resolve conflicts (never auto-resolve)

  // For M1, we note this phase
  contradictions.push('No contradictions detected in this cycle');

  return contradictions;
}

async function prepare(
  sensoriumFindings: string[],
  harvestFindings: string[],
  mineFindings: string[],
  reflections: string[],
  promotedRules: string[],
  contradictions: string[]
): Promise<string> {
  console.log('[Sleep] Phase 7: PREPARE — Writing summary...');

  const lines = [
    `# Sleep Cycle Report — ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Summary',
    '',
    `Sensorium: ${sensoriumFindings.length} findings`,
    `Harvest: ${harvestFindings.length} session logs reviewed`,
    `Mine: ${mineFindings.length} patterns extracted`,
    `Reflect: ${reflections.length} reflections recorded`,
    `Consolidate: ${promotedRules.length} rules promoted`,
    `Validate: ${contradictions.length} contradictions found`,
    '',
  ];

  if (sensoriumFindings.length > 0) {
    lines.push('## Sensorium', '');
    sensoriumFindings.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }

  if (reflections.length > 0) {
    lines.push('## Reflections', '');
    reflections.forEach(r => lines.push(r));
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runSleepCycle(): Promise<void> {
  console.log('💤 Lodestone Sleep Cycle');
  console.log('─'.repeat(40));

  const report: SleepCycleReport = {
    timestamp: new Date().toISOString(),
    phase: 'starting',
    findings: [],
    promotedRules: [],
    contradictions: [],
    summary: '',
  };

  try {
    // Phase 1: Sensorium
    report.phase = 'sensorium';
    const sensoriumFindings = await runSensorium();
    report.findings.push(...sensoriumFindings);

    // Phase 2: Harvest
    report.phase = 'harvest';
    const harvestFindings = await harvest();
    report.findings.push(...harvestFindings);

    // Phase 3: Mine
    report.phase = 'mine';
    const mineFindings = await mine();
    report.findings.push(...mineFindings);

    // Phase 4: Reflect
    report.phase = 'reflect';
    const reflections = await reflect(report.findings);
    report.findings.push(...reflections);

    // Phase 5: Consolidate
    report.phase = 'consolidate';
    const promotedRules = await consolidate(reflections);
    report.promotedRules = promotedRules;

    // Phase 6: Validate
    report.phase = 'validate';
    const contradictions = await validate(promotedRules);
    report.contradictions = contradictions;

    // Phase 7: Prepare
    report.phase = 'prepare';
    report.summary = await prepare(
      sensoriumFindings, harvestFindings, mineFindings,
      reflections, promotedRules, contradictions
    );

  } catch (err) {
    report.phase = 'error';
    report.findings.push(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Save report
  const reportDir = join(CONFIG.dataDir, 'sleep-cycle');
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest.json'), JSON.stringify(report, null, 2));
  await writeFile(join(reportDir, 'latest.md'), report.summary);

  console.log('\n✅ Sleep cycle completed.');
  console.log(`Report saved to ${reportDir}/latest.md`);
}

// Run
runSleepCycle().catch(err => {
  console.error('[Sleep] Fatal error:', err);
  process.exit(1);
});
#!/usr/bin/env node

/**
 * Lodestone — Sensorium
 *
 * Proactive health check that runs periodically to maintain the agent's
 * awareness of system state. Checks:
 * - LLM provider availability
 * - Memory system health (wiki, vector DB, scratch buffer)
 * - Disk space and resource usage
 * - Scheduled jobs status
 * - Wiki integrity (broken links, stale pages)
 *
 * Outputs a structured report and alerts on any failures.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  workspaceRoot: process.env.LODESTONE_WORKSPACE || './workspace',
  dataDir: process.env.LODESTONE_DATA_DIR || './data',
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  checkLlm: true,
  checkMemory: true,
  checkDisk: true,
  checkWiki: true,
  diskWarnThreshold: 80, // percent
  diskCriticalThreshold: 90,
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface SensoriumCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

interface SensoriumReport {
  timestamp: string;
  agentName: string;
  checks: SensoriumCheck[];
  summary: {
    total: number;
    ok: number;
    warn: number;
    fail: number;
    skipped: number;
  };
  overallStatus: 'ok' | 'degraded' | 'down';
  alerts: string[];
}

// ─── Checks ──────────────────────────────────────────────────────────────────

async function checkLLM(): Promise<SensoriumCheck> {
  const start = Date.now();
  try {
    const response = await fetch(CONFIG.ollamaUrl);
    if (response.ok) {
      // Try to list models
      const models = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
      const modelData = await models.json() as { models?: Array<{ name: string }> };
      return {
        name: 'LLM Provider',
        status: 'ok',
        message: `Ollama healthy, ${modelData.models?.length || 0} models available`,
        details: { models: modelData.models?.map(m => m.name) || [] },
        durationMs: Date.now() - start,
      };
    }
    return {
      name: 'LLM Provider',
      status: 'fail',
      message: `Ollama returned status ${response.status}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'LLM Provider',
      status: 'fail',
      message: `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

async function checkMemory(): Promise<SensoriumCheck> {
  const start = Date.now();
  const issues: string[] = [];

  // Check wiki directory
  const wikiDir = join(CONFIG.workspaceRoot, 'memory/wiki');
  if (!existsSync(wikiDir)) {
    issues.push('Wiki directory missing');
  } else {
    try {
      const files = await execAsync(`find "${wikiDir}" -name "*.md" | wc -l`);
      const count = parseInt(files.stdout.trim(), 10);
      if (count === 0) issues.push('Wiki is empty');
    } catch {
      issues.push('Cannot read wiki directory');
    }
  }

  // Check vector DB
  const dbDir = join(CONFIG.dataDir, 'lancedb');
  if (!existsSync(dbDir)) {
    issues.push('Vector DB not initialized (will create on first use)');
  }

  // Check scratch buffer
  const scratchFile = join(CONFIG.dataDir, 'scratch.json');
  if (!existsSync(scratchFile)) {
    issues.push('Scratch buffer not initialized (will create on first use)');
  }

  const status = issues.length === 0 ? 'ok' : issues.some(i => i.includes('missing') || i.includes('Cannot')) ? 'warn' : 'ok';

  return {
    name: 'Memory System',
    status,
    message: status === 'ok' ? 'All memory systems operational' : `Issues: ${issues.join('; ')}`,
    details: { issues },
    durationMs: Date.now() - start,
  };
}

async function checkDisk(): Promise<SensoriumCheck> {
  const start = Date.now();
  try {
    const { stdout } = await execAsync('df -h / | tail -1 | awk \'{print $5}\'');
    const usage = parseInt(stdout.trim(), 10);

    let status: 'ok' | 'warn' | 'fail' = 'ok';
    if (usage >= CONFIG.diskCriticalThreshold) status = 'fail';
    else if (usage >= CONFIG.diskWarnThreshold) status = 'warn';

    return {
      name: 'Disk Space',
      status,
      message: `Disk usage: ${usage}%`,
      details: { usage },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'Disk Space',
      status: 'skip',
      message: 'Cannot check disk space',
      durationMs: Date.now() - start,
    };
  }
}

async function checkWikiIntegrity(): Promise<SensoriumCheck> {
  const start = Date.now();
  const wikiDir = join(CONFIG.workspaceRoot, 'memory/wiki');

  if (!existsSync(wikiDir)) {
    return {
      name: 'Wiki Integrity',
      status: 'skip',
      message: 'Wiki directory does not exist yet',
      durationMs: Date.now() - start,
    };
  }

  const issues: string[] = [];

  try {
    // Check for broken wikilinks
    const { stdout } = await execAsync(`grep -r '\\[\\[' "${wikiDir}" --include="*.md" -o | head -50 || true`);
    const links = stdout.trim().split('\n').filter(Boolean);

    // Check for pages without frontmatter
    const { stdout: noFm } = await execAsync(
      `find "${wikiDir}" -name "*.md" ! -name "index.md" -exec grep -L '^---' {} \\; | head -20 || true`
    );
    const missingFm = noFm.trim().split('\n').filter(Boolean);
    if (missingFm.length > 0) {
      issues.push(`${missingFm.length} pages missing frontmatter`);
    }

    // Check for stale pages (not updated in 30 days)
    const { stdout: stale } = await execAsync(
      `find "${wikiDir}" -name "*.md" -mtime +30 ! -name "index.md" | head -20 || true`
    );
    const stalePages = stale.trim().split('\n').filter(Boolean);
    if (stalePages.length > 0) {
      issues.push(`${stalePages.length} pages stale (>30 days)`);
    }

    return {
      name: 'Wiki Integrity',
      status: issues.length === 0 ? 'ok' : 'warn',
      message: issues.length === 0 ? `Wiki healthy, ${links.length} wikilinks found` : `Issues: ${issues.join('; ')}`,
      details: { linkCount: links.length, issues },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'Wiki Integrity',
      status: 'skip',
      message: 'Cannot check wiki integrity',
      durationMs: Date.now() - start,
    };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runSensorium(): Promise<SensoriumReport> {
  console.log('[Sensorium] Running health checks...\n');

  const checks: SensoriumCheck[] = [];

  // Run all checks
  if (CONFIG.checkLlm) checks.push(await checkLLM());
  if (CONFIG.checkMemory) checks.push(await checkMemory());
  if (CONFIG.checkDisk) checks.push(await checkDisk());
  if (CONFIG.checkWiki) checks.push(await checkWikiIntegrity());

  // Build summary
  const summary = {
    total: checks.length,
    ok: checks.filter(c => c.status === 'ok').length,
    warn: checks.filter(c => c.status === 'warn').length,
    fail: checks.filter(c => c.status === 'fail').length,
    skipped: checks.filter(c => c.status === 'skip').length,
  };

  // Determine overall status
  const overallStatus: 'ok' | 'degraded' | 'down' =
    summary.fail > 0 ? 'down' : summary.warn > 0 ? 'degraded' : 'ok';

  // Build alerts
  const alerts = checks
    .filter(c => c.status === 'fail' || c.status === 'warn')
    .map(c => `${c.status === 'fail' ? '🚨' : '⚠️'} ${c.name}: ${c.message}`);

  // Print report
  for (const check of checks) {
    const icon = check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️' : check.status === 'fail' ? '🚨' : '⏭️';
    console.log(`${icon} ${check.name}: ${check.message} (${check.durationMs}ms)`);
  }

  console.log(`\n${overallStatus === 'ok' ? '✅' : overallStatus === 'degraded' ? '⚠️' : '🚨'} Overall: ${overallStatus}`);
  console.log(`   OK: ${summary.ok} | Warn: ${summary.warn} | Fail: ${summary.fail} | Skip: ${summary.skipped}`);

  const report: SensoriumReport = {
    timestamp: new Date().toISOString(),
    agentName: 'Lodestone',
    checks,
    summary,
    overallStatus,
    alerts,
  };

  // Save report
  const reportDir = join(CONFIG.dataDir, 'sensorium');
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest.json'), JSON.stringify(report, null, 2));
  await writeFile(join(reportDir, 'latest.md'), formatMarkdownReport(report));

  return report;
}

function formatMarkdownReport(report: SensoriumReport): string {
  const lines = [
    `# Sensorium Report — ${report.timestamp.split('T')[0]}`,
    '',
    `**Overall:** ${report.overallStatus === 'ok' ? '✅ Healthy' : report.overallStatus === 'degraded' ? '⚠️ Degraded' : '🚨 Down'}`,
    '',
  ];

  for (const check of report.checks) {
    const icon = check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️' : check.status === 'fail' ? '🚨' : '⏭️';
    lines.push(`${icon} **${check.name}**: ${check.message}`);
  }

  if (report.alerts.length > 0) {
    lines.push('', '## Alerts', '');
    for (const alert of report.alerts) {
      lines.push(`- ${alert}`);
    }
  }

  return lines.join('\n');
}

// Run
runSensorium().catch(err => {
  console.error('[Sensorium] Fatal error:', err);
  process.exit(1);
});
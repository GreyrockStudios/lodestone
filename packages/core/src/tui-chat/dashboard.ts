/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- TUI code uses dynamic types throughout */
/**
 * Lodestone — Improvement Dashboard Renderer
 *
 * Builds the self-improvement dashboard text for /improve command.
 */

import { Theme, fg } from './theme.js';

const R = '\x1B[0m';
const B = '\x1B[1m';
const D = '\x1B[2m';

/**
 * Build a formatted dashboard string showing self-improvement system status,
 * including predictions, drift, skills, and sleep cycle metrics.
 * @param engine - The LodestoneEngine instance (typed as any for TUI flexibility).
 * @param theme - The active theme for coloring.
 * @returns ANSI-formatted string for display in the TUI.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TUI engine type varies
export async function buildImproveDashboard(engine: any, theme: Theme): Promise<string> {
  const P = theme.colors;
  const imp = engine.improvement;
  const lines: string[] = [];

  lines.push(`${B}${fg(P.accent)}${theme.statusBar.icon} Self-Improvement Dashboard${R}\n`);

  // Prediction Journal
  try {
    const calib = await imp.predictionJournal.calibrate();
    const pending = await imp.predictionJournal.list({ status: 'pending' });
    const met = await imp.predictionJournal.list({ status: 'met' });
    const missed = await imp.predictionJournal.list({ status: 'missed' });
    lines.push(`${B}${fg(P.info)}📊 Predictions${R}`);
    lines.push(`  Total: ${calib.totalPredictions}  |  Pending: ${pending.length}  |  Met: ${met.length}  |  Missed: ${missed.length}`);
    lines.push(`  Accuracy: ${(calib.accuracy * 100).toFixed(0)}%  |  Brier Score: ${calib.brierScore.toFixed(3)}`);
    if (calib.buckets && calib.buckets.length > 0) {
      lines.push(`  Calibration: ` + calib.buckets.map((b: { range: [number, number]; accuracy: number }) =>
        `${(b.range[0] * 100).toFixed(0)}-${(b.range[1] * 100).toFixed(0)}%: ${(b.accuracy * 100).toFixed(0)}% accurate`
      ).join(', '));
    }
    lines.push('');
  } catch (e: unknown) {
    lines.push(`${fg(P.warn)}⚠ Predictions: ${e instanceof Error ? e.message : String(e)}${R}\n`);
  }

  // RBT Diagnosis
  try {
    const latest = await imp.rbtDiagnosis.getLatest();
    lines.push(`${B}${fg(P.success)}🌹 RBT Diagnosis${R}`);
    if (latest) {
      lines.push(`  Roses: ${latest.roses.length}  |  Buds: ${latest.buds.length}  |  Thorns: ${latest.thorns.length}`);
      if (latest.summary) lines.push(`  ${D}${latest.summary.slice(0, 150)}${R}`);
    } else {
      lines.push(`  ${D}No RBT reports yet. Run /rbt to create one.${R}`);
    }
    lines.push('');
  } catch (e: unknown) {
    lines.push(`${fg(P.warn)}⚠ RBT: ${e instanceof Error ? e.message : String(e)}${R}\n`);
  }

  // Drift Detector
  try {
    const latestDrift = await imp.driftDetector.getLatest();
    lines.push(`${B}${fg(P.purple)}🧭 Drift${R}`);
    if (latestDrift) {
      const pct = (latestDrift.overallDrift * 100).toFixed(0);
      const color = latestDrift.overallDrift < 0.2 ? fg(P.success) : latestDrift.overallDrift < 0.5 ? fg(P.warn) : fg(P.error);
      lines.push(`  Overall drift: ${color}${pct}%${R}  |  Flagged: ${latestDrift.flagged.length}`);
      if (latestDrift.flagged.length > 0) {
        lines.push(`  ${latestDrift.flagged.slice(0, 3).map((f: { rule?: string; principle?: string }) => `${fg(P.error)}${f.rule || f.principle || 'unknown'}${R}`).join(', ')}`);
      }
    } else {
      lines.push(`  ${D}No drift reports yet. Run /drift to check.${R}`);
    }
    lines.push('');
  } catch (e: unknown) {
    lines.push(`${fg(P.warn)}⚠ Drift: ${e instanceof Error ? e.message : String(e)}${R}\n`);
  }

  // Skill Evolution
  try {
    const lessons = await imp.skillEvolver.listLessons({ limit: 100 });
    const skills = await imp.skillEvolver.listSkills();
    const validated = lessons.filter((l: { validations: number; contradictions: number; confidence: number; lesson: string }) => l.validations >= 2);
    const contradicted = lessons.filter((l: { validations: number; contradictions: number; confidence: number; lesson: string }) => l.contradictions > 0);
    lines.push(`${B}${fg(P.pink)}🧬 Skills & Lessons${R}`);
    lines.push(`  Lessons: ${lessons.length}  |  Validated (2+): ${validated.length}  |  Contradicted: ${contradicted.length}`);
    lines.push(`  Promoted skills: ${skills.length}`);
    if (lessons.length > 0) {
      lines.push(`  Recent: ${lessons.slice(0, 3).map((l: { validations: number; contradictions: number; confidence: number; lesson: string }) => `"${l.lesson.slice(0, 40)}..." (${(l.confidence * 100).toFixed(0)}%)`).join('\n           ')}`);
    }
    lines.push('');
  } catch (e: unknown) {
    lines.push(`${fg(P.warn)}⚠ Skills: ${e instanceof Error ? e.message : String(e)}${R}\n`);
  }

  // Sleep Cycle
  try {
    const sleepJob = imp.getSleepCycleJob();
    lines.push(`${B}🌙 Sleep Cycle${R}`);
    lines.push(`  Schedule: ${sleepJob.schedule.kind === 'cron' ? sleepJob.schedule.expr : 'interval'}  |  Enabled: ${sleepJob.enabled ? '✓' : '✗'}`);
  } catch (e: unknown) {
    lines.push(`${fg(P.warn)}⚠ Sleep: ${e instanceof Error ? e.message : String(e)}${R}`);
  }

  return lines.join('\n');
}
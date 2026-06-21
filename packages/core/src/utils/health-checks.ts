/**
 * Lodestone Health Checks
 *
 * Real health checking — pings LLM, checks channels, inspects disk/memory.
 * Caches results for 30s to avoid hammering external services.
 *
 * No external dependencies — uses built-in modules only.
 */

import { statfsSync } from 'node:fs';
import { Logger, getLogger } from './logger.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ChannelManager } from '../channels/manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface DiskCheckResult {
  ok: boolean;
  used: number;   // bytes used
  free: number;   // bytes free
  total: number;   // bytes total
  usedPercent: number;
}

export interface MemoryCheckResult {
  ok: boolean;
  used: number;     // bytes used by process
  total: number;    // bytes — system total or heap limit
  usedPercent: number;
}

export interface ChannelCheckResult {
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  checks: {
    llm?: HealthCheckResult;
    channels: ChannelCheckResult[];
    disk?: DiskCheckResult;
    memory?: MemoryCheckResult;
  };
  overall: {
    total: number;
    passed: number;
    failed: number;
  };
}

export interface HealthCheckOptions {
  llm?: {
    provider: LLMProvider;
  };
  channels?: {
    manager: ChannelManager;
  };
  disk?: {
    path: string;
    thresholdPercent: number; // e.g. 90 means warn if >90% full
  };
  memory?: {
    thresholdPercent: number; // e.g. 80 means warn if >80% of heap
  };
}

// ─── Health Checker ─────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;

export class HealthChecker {
  private logger: Logger | ReturnType<Logger['child']>;
  private cachedReport: HealthReport | null = null;
  private cachedAt: number = 0;

  constructor(logger?: Logger) {
    this.logger = logger ? logger.child('health-checker') : getLogger('health-checker');
  }

  /**
   * Ping the LLM with a minimal request to verify connectivity.
   */
  async checkLLM(provider: LLMProvider): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const model = provider.getModel();
      // Use generateText-style minimal call via the AI SDK
      const { generateText } = await import('ai');
      await generateText({
        model,
        prompt: 'ping',
      });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn('LLM health check failed', { error: errorMsg, latencyMs });
      return { ok: false, latencyMs, error: errorMsg };
    }
  }

  /**
   * Check each channel's health by testing if it's active.
   */
  checkChannels(manager: ChannelManager): ChannelCheckResult[] {
    const results: ChannelCheckResult[] = [];
    const channels = manager.listChannels();

    for (const ch of channels) {
      const start = Date.now();
      try {
        const ok = ch.isActive();
        results.push({
          name: ch.name,
          ok,
          latencyMs: Date.now() - start,
          error: ok ? undefined : 'Channel not active',
        });
      } catch (err) {
        results.push({
          name: ch.name,
          ok: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Check disk space on the given path.
   * Uses statfs which is available on Linux and macOS.
   */
  checkDisk(path: string, thresholdPercent: number): DiskCheckResult {
    try {
      // statfsSync returns a StatFs object with bsize, blocks, bavail fields.
      // This is available on Linux and macOS (Node >= 18).
      const stats = statfsSync(path);
      const bsize = stats.bsize;
      const total = stats.blocks * bsize;
      const free = stats.bavail * bsize;
      const used = total - free;
      const usedPercent = total > 0 ? (used / total) * 100 : 0;

      return {
        ok: usedPercent < thresholdPercent,
        used,
        free,
        total,
        usedPercent: Math.round(usedPercent * 100) / 100,
      };
    } catch (err) {
      this.logger.warn('Disk check failed', { path, error: err instanceof Error ? err.message : String(err) });
      return {
        ok: false,
        used: 0,
        free: 0,
        total: 0,
        usedPercent: 0,
      };
    }
  }

  /**
   * Check process memory usage against threshold.
   */
  checkMemory(thresholdPercent: number): MemoryCheckResult {
    const mem = process.memoryUsage();
    const total = mem.heapTotal;
    const used = mem.heapUsed;
    const usedPercent = total > 0 ? (used / total) * 100 : 0;

    return {
      ok: usedPercent < thresholdPercent,
      used,
      total,
      usedPercent: Math.round(usedPercent * 100) / 100,
    };
  }

  /**
   * Run all configured health checks and return a unified report.
   * Results are cached for 30 seconds.
   */
  async runAll(opts: HealthCheckOptions): Promise<HealthReport> {
    // Return cached if fresh
    if (this.cachedReport && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      this.logger.debug('Returning cached health report', { age: Date.now() - this.cachedAt });
      return this.cachedReport;
    }

    const checks: HealthReport['checks'] = {
      channels: [],
    };
    const allResults: { ok: boolean }[] = [];

    // LLM check
    if (opts.llm?.provider) {
      const llmResult = await this.checkLLM(opts.llm.provider);
      checks.llm = llmResult;
      allResults.push(llmResult);
    }

    // Channels check
    if (opts.channels?.manager) {
      const chResults = this.checkChannels(opts.channels.manager);
      checks.channels = chResults;
      for (const r of chResults) {
        allResults.push(r);
      }
    }

    // Disk check
    if (opts.disk?.path && opts.disk?.thresholdPercent !== undefined) {
      const diskResult = this.checkDisk(opts.disk.path, opts.disk.thresholdPercent);
      checks.disk = diskResult;
      allResults.push(diskResult);
    }

    // Memory check
    if (opts.memory?.thresholdPercent !== undefined) {
      const memResult = this.checkMemory(opts.memory.thresholdPercent);
      checks.memory = memResult;
      allResults.push(memResult);
    }

    // Determine overall status
    const total = allResults.length;
    const failed = allResults.filter(r => !r.ok).length;
    const passed = total - failed;

    let status: HealthReport['status'] = 'ok';
    if (failed === total && total > 0) {
      status = 'down';
    } else if (failed > 0) {
      status = 'degraded';
    }

    const report: HealthReport = {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
      overall: { total, passed, failed },
    };

    // Cache
    this.cachedReport = report;
    this.cachedAt = Date.now();

    this.logger.info('Health check completed', {
      status,
      passed,
      failed,
      total,
    });

    return report;
  }

  /** Clear the cache, forcing a fresh check on next call */
  clearCache(): void {
    this.cachedReport = null;
    this.cachedAt = 0;
  }
}
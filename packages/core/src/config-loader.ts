/**
 * Lodestone — Shared Config Loader
 *
 * Loads and parses lodestone.config.yaml into a full LodestoneConfig object.
 * Used by both main.ts (direct entry) and cli/start.ts (CLI entry) to avoid
 * duplicated config parsing logic.
 */

import { readFile } from 'fs/promises';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { ConfigValidator, lodestoneSchema } from './utils/config-validator.js';
import type { LodestoneConfig } from './engine.js';
import type { ChannelConfig } from './channels/channel.js';
import type { ProactiveConfig } from './improvement/proactive-intelligence.js';

export interface LoadConfigOptions {
  /** Path to config file */
  configPath?: string;
  /** Override workspace root */
  workspace?: string;
  /** Override model */
  model?: string;
}

/**
 * Load and parse a Lodestone config file into a full LodestoneConfig.
 *
 * Handles all config sections: llm, channels, dashboard, safety, memory,
 * session, scheduler, logging, proactive, etc.
 *
 * Falls back to sensible defaults if the file is missing or incomplete.
 */
export async function loadConfigFromFile(
  configPath?: string,
  options?: LoadConfigOptions,
): Promise<LodestoneConfig> {
  const path = configPath || process.env.LODESTONE_CONFIG || './lodestone.config.yaml';
  const workspaceOverride = options?.workspace;
  const modelOverride = options?.model;

  try {
    const raw = await readFile(path, 'utf-8');
    const config = parseYaml(raw);

    // Validate config
    const validator = new ConfigValidator(lodestoneSchema);
    const result = validator.validate(config);
    if (!result.valid) {
      console.error('[Lodestone] Config validation failed:');
      for (const err of result.errors) {
        console.error(`  ❌ ${err.path}: ${err.message}`);
      }
      console.error('[Lodestone] Fix the config or use defaults.');
    }
    for (const warn of result.warnings) {
      console.warn(`  ⚠️  ${warn.path}: ${warn.message}`);
    }

    return {
      configPath: path,
      workspaceRoot: workspaceOverride || config.workspace?.root || process.env.LODESTONE_WORKSPACE || './workspace',
      identityDir: config.identity?.dir || '.',
      wikiRoot: config.memory?.wiki?.path || './workspace/memory/wiki',
      memoryDir: config.memory?.vectorDb?.path || './workspace/data/lancedb',
      embeddingProvider: config.memory?.vectorDb?.embedding?.provider,
      embeddingModel: config.memory?.vectorDb?.embedding?.model,
      embeddingDimensions: config.memory?.vectorDb?.embedding?.dimensions,
      autoCapture: config.memory?.vectorDb?.autoCapture ?? true,
      autoRecall: config.memory?.vectorDb?.autoRecall ?? true,
      scratchPath: config.memory?.scratch?.path || join(config.workspace?.root || './workspace', 'data/scratch.json'),
      sessionKeepRecentCount: config.session?.keepRecentCount,
      sessionMaxEntries: config.session?.maxEntries,
      sessionPruneAfter: config.session?.pruneAfter,
      logging: config.logging,
      maxConcurrentTools: config.scheduler?.maxConcurrent || 4,
      maxConcurrentJobs: config.scheduler?.maxConcurrent || 4,
      compactionThreshold: config.session?.compactionThreshold || 0.5,
      llm: {
        default: {
          type: config.llm?.default?.type || 'ollama',
          model: modelOverride || config.llm?.default?.model || 'glm-5.2:cloud',
          baseUrl: config.llm?.default?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api',
          apiKey: config.llm?.default?.apiKey || process.env.OPENAI_API_KEY,
          contextWindow: config.llm?.default?.contextWindow || 128000,
          maxTokens: config.llm?.default?.maxTokens || 8192,
        },
        routes: Object.entries(config.llm?.routes || {}).map(([name, route]) => {
          const r = route as Record<string, unknown>;
          return {
            name,
            provider: {
              type: ((r.type as string) || 'ollama') as 'ollama' | 'openai' | 'anthropic' | 'custom',
              model: r.model as string,
              baseUrl: r.baseUrl as string | undefined,
              apiKey: r.apiKey as string | undefined,
              contextWindow: (r.contextWindow as number) || 128000,
              maxTokens: (r.maxTokens as number) || 8192,
            },
          };
        }),
      },
      channels: config.channels ? {
        channels: Object.entries(config.channels || {})
          .map(([name, ch]) => ({ ...ch as Record<string, unknown>, type: (ch as Record<string, unknown>).type || name }))
          .filter((ch: Record<string, unknown>) => ch.enabled !== false) as unknown as ChannelConfig[],
      } : undefined,
      dashboard: config.dashboard ? {
        port: config.dashboard.port || 3002,
        host: config.dashboard.host || '127.0.0.1',
        dashboardDir: config.dashboard.dashboardDir || './packages/core/src/dashboard',
        apiToken: config.dashboard.apiToken,
        corsOrigin: config.dashboard.corsOrigin || '*',
      } : undefined,
      safety: config.safety,
      costTracking: config.costTracking,
      modelRouting: config.modelRouting,
      webhooks: config.webhooks,
      abTesting: config.abTesting,
      email: config.email,
      calendar: config.calendar,
      auth: config.auth,
      proactive: config.proactive ? {
        dataDir: config.proactive.dataDir || join(config.workspace?.root || './workspace', 'data/proactive'),
        workspaceRoot: config.workspace?.root || workspaceOverride || './workspace',
        checkIntervalMs: config.proactive.sensorium?.interval
          ? parseInterval(config.proactive.sensorium.interval)
          : config.proactive.checkIntervalMs || 30 * 60 * 1000,
        minConfidence: config.proactive.minConfidence,
        maxSuggestions: config.proactive.maxSuggestions,
      } as ProactiveConfig : undefined,
    };
  } catch (err) {
    console.error('[Lodestone] Failed to load config:', err);
    console.error('[Lodestone] Using defaults');
    return {
      workspaceRoot: workspaceOverride || process.env.LODESTONE_WORKSPACE || './workspace',
      identityDir: '.',
      wikiRoot: './workspace/memory/wiki',
      memoryDir: './workspace/data/lancedb',
      llm: {
        default: {
          type: 'ollama',
          model: modelOverride || 'glm-5.2:cloud',
          baseUrl: 'http://127.0.0.1:11434/api',
          contextWindow: 128000,
          maxTokens: 8192,
        },
      },
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse human-readable interval strings (e.g. "30m", "1h", "15s") to milliseconds. */
function parseInterval(str: string | number): number {
  if (typeof str === 'number') return str;
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(str);
  if (!match) return 30 * 60 * 1000; // default 30min
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}
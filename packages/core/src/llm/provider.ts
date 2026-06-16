/**
 * Lodestone Core — LLM Provider Abstraction
 *
 * Abstracts across Ollama, OpenAI, Anthropic, and any OpenAI-compatible API.
 * Uses Vercel AI SDK as the unified interface for streaming, tool calling,
 * and token counting.
 */

import { createOllama } from 'ollama-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV1 } from 'ai';

// ─── Provider Types ────────────────────────────────────────────────────────

export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'custom';

export interface ProviderConfig {
  type: ProviderType;
  /** Base URL for API (default: provider-specific) */
  baseUrl?: string;
  /** API key (not needed for local Ollama) */
  apiKey?: string;
  /** Model identifier (e.g. 'glm-5.1:cloud', 'gpt-4o', 'claude-sonnet-4-20250514') */
  model: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Whether this model supports reasoning/thinking */
  reasoning?: boolean;
  /** Custom headers to send with every request */
  headers?: Record<string, string>;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  maxContextWindow: number;
}

// ─── Provider Factory ──────────────────────────────────────────────────────

export class LLMProvider {
  private config: ProviderConfig;
  private model: LanguageModelV1;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.model = this.createModel(config);
  }

  private createModel(config: ProviderConfig): LanguageModelV1 {
    switch (config.type) {
      case 'ollama': {
        const ollama = createOllama({
          baseURL: config.baseUrl || 'http://127.0.0.1:11434',
        });
        return ollama(config.model);
      }

      case 'openai': {
        const openai = createOpenAI({
          baseURL: config.baseUrl,
          apiKey: config.apiKey,
        });
        return openai(config.model);
      }

      case 'anthropic': {
        const anthropic = createAnthropic({
          baseURL: config.baseUrl,
          apiKey: config.apiKey,
        });
        return anthropic(config.model);
      }

      case 'custom': {
        // Any OpenAI-compatible API (vLLM, LM Studio, etc.)
        const custom = createOpenAI({
          baseURL: config.baseUrl!,
          apiKey: config.apiKey || 'not-needed',
          headers: config.headers,
        });
        return custom(config.model);
      }

      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /** Get the Vercel AI SDK model instance */
  getModel(): LanguageModelV1 {
    return this.model;
  }

  /** Get provider config (safe copy) */
  getConfig(): Readonly<ProviderConfig> {
    return { ...this.config };
  }

  /** Get model ID */
  getModelId(): string {
    return this.config.model;
  }

  /** Get context window size */
  getContextWindow(): number {
    return this.config.contextWindow || 128000;
  }

  /** Get max output tokens */
  getMaxTokens(): number {
    return this.config.maxTokens || 8192;
  }

  /** Does this model support reasoning? */
  hasReasoning(): boolean {
    return this.config.reasoning ?? false;
  }

  /** Get provider capabilities */
  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      vision: ['openai', 'anthropic'].includes(this.config.type),
      reasoning: this.hasReasoning(),
      maxContextWindow: this.getContextWindow(),
    };
  }
}

// ─── Multi-Model Router ────────────────────────────────────────────────────

export interface ModelRoute {
  /** Pattern to match against (e.g. 'fast', 'smart', 'vision') */
  name: string;
  /** Provider to use for this route */
  provider: ProviderConfig;
}

export class LLMRouter {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider: LLMProvider;

  constructor(defaultConfig: ProviderConfig, routes?: ModelRoute[]) {
    this.defaultProvider = new LLMProvider(defaultConfig);
    this.providers.set('default', this.defaultProvider);

    if (routes) {
      for (const route of routes) {
        this.providers.set(route.name, new LLMProvider(route.provider));
      }
    }
  }

  /** Get provider by route name (falls back to default) */
  getProvider(route?: string): LLMProvider {
    return this.providers.get(route || 'default') || this.defaultProvider;
  }

  /** Get all available routes */
  getRoutes(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Get default provider */
  getDefault(): LLMProvider {
    return this.defaultProvider;
  }
}
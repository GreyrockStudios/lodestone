/**
 * Lodestone Core — Developer SDK
 *
 * A clean, high-level API for embedding Lodestone into applications.
 * Wraps the engine with a simpler surface: createAgent(), namespaces
 * for tools/channels/memory/safety, event emitter, and middleware.
 *
 * Usage:
 *   const sdk = createAgent({ ...config });
 *   sdk.tools.register(myTool);
 *   sdk.on('message.received', handler);
 *   await sdk.start();
 *   const response = await sdk.processMessage(sessionId, "Hello");
 *   await sdk.stop();
 *
 * This is the stable public API. Internal restructuring won't break
 * SDK consumers as long as the signatures here hold.
 */

import { EventEmitter } from 'events';
import { Logger, ChildLogger, getLogger } from './utils/logger.js';
import {
  LodestoneEngine,
  type LodestoneConfig,
  type EngineEvent,
} from './engine.js';
import { ToolRegistry, type Tool, type ToolDefinition, type ToolResult, type ToolContext } from './tools/definitions.js';
import type { Session, SessionMessage } from './session/manager.js';
import { ChannelManager } from './channels/manager.js';
import { MemorySystem } from './memory/memory-system.js';
import type { WikiPage } from './memory/wiki-store.js';
import { SafetySystem } from './safety/index.js';
import { PluginManager, type Plugin, type PluginInfo, type PluginCustomEvent } from './plugin-system.js';

// ─── SDK Types ─────────────────────────────────────────────────────────────

/**
 * Configuration for createAgent(). Extends LodestoneConfig with
 * SDK-specific options like plugins and middleware.
 */
export interface SDKConfig extends LodestoneConfig {
  /** Plugins to register at startup */
  plugins?: { plugin: Plugin; config?: Record<string, unknown> }[];
  /** Whether to auto-start the engine after creation (default: false) */
  autoStart?: boolean;
}

/**
 * Middleware function signature. Can modify the request or response,
 * or short-circuit by returning a result directly.
 */
export type MiddlewareFn<T extends unknown = unknown> = (
  value: T,
  next: () => Promise<T>,
) => Promise<T>;

// ─── SDK Lifecycle Events ─────────────────────────────────────────────────

export type SDKEvent =
  | EngineEvent
  | { type: 'plugin.custom'; event: PluginCustomEvent }
  | { type: 'sdk.starting'; timestamp: string }
  | { type: 'sdk.started'; timestamp: string }
  | { type: 'sdk.stopping'; timestamp: string }
  | { type: 'sdk.stopped'; timestamp: string };

// ─── Namespace Types ───────────────────────────────────────────────────────

/**
 * Tools namespace — register, list, and execute tools.
 */
export interface ToolsNamespace {
  /** Register a tool */
  register(tool: Tool): void;
  /** Get a tool by ID */
  get(toolId: string): Tool | undefined;
  /** List all registered tool definitions */
  list(): ToolDefinition[];
  /** Execute a tool by ID with given parameters */
  execute(toolId: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/**
 * Channels namespace — manage messaging channels.
 */
export interface ChannelsNamespace {
  /** Get the channel manager (if configured) */
  manager: ChannelManager | null;
  /** List active channel IDs */
  list(): string[];
}

/**
 * Memory namespace — access memory subsystems.
 */
export interface MemoryNamespace {
  /** Store a fact in long-term memory */
  store(key: string, value: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Recall facts from long-term memory */
  recall(query: string, limit?: number): Promise<{ text: string; relevance: number; timestamp: string }[]>;
  /** Read a wiki page by slug (returns page content or null) */
  wikiRead(slug: string): Promise<WikiPage | null>;
  /** Write/update a wiki page */
  wikiWrite(slug: string, content: string, frontmatter?: Record<string, unknown>): Promise<WikiPage>;
  /** Search wiki pages */
  wikiSearch(query: string, limit?: number): Promise<{ slug: string; title: string; excerpt: string; score: number }[]>;
  /** Get a scratch buffer value */
  scratchGet(key: string): Promise<string | null>;
  /** Set a scratch buffer value */
  scratchSet(key: string, value: string, ttlMs?: number): Promise<void>;
}

/**
 * Safety namespace — access safety subsystems.
 */
export interface SafetyNamespace {
  /** Check if a tool can be auto-approved */
  canAutoApprove(toolId: string): boolean;
  /** Check if a tool can run in sleep mode */
  canRunInSleep(toolId: string): boolean;
  /** Get behavioral rules for prompt injection */
  getRules(): string;
  /** Simulate a privileged tool execution */
  simulate(toolId: string, params: Record<string, unknown>): { approved: boolean; riskLevel: string; predictedOutcome: string };
}

/**
 * Plugins namespace — manage registered plugins.
 */
export interface PluginsNamespace {
  /** List all registered plugins */
  list(): PluginInfo[];
  /** Get info for a specific plugin */
  get(pluginId: string): PluginInfo | undefined;
  /** Count active plugins */
  count(): number;
  /** Register a new plugin at runtime */
  register(plugin: Plugin, config?: Record<string, unknown>): Promise<void>;
  /** Unregister a plugin */
  unregister(pluginId: string): Promise<void>;
}

// ─── Lodestone SDK Class ───────────────────────────────────────────────────

/**
 * The main SDK class. Exposes namespaced access to engine subsystems
 * with a clean, stable API surface.
 */
export class LodestoneSDK extends EventEmitter {
  readonly engine: LodestoneEngine;
  readonly log: Logger | ChildLogger;

  // Namespaces
  readonly tools: ToolsNamespace;
  readonly channels: ChannelsNamespace;
  readonly memory: MemoryNamespace;
  readonly safety: SafetyNamespace;
  readonly plugins: PluginsNamespace;

  // Plugin manager (internal but accessible for hook routing)
  readonly pluginManager: PluginManager;

  // Middleware chains
  private requestMiddleware: MiddlewareFn<SDKRequest>[] = [];
  private responseMiddleware: MiddlewareFn<SDKResponse>[] = [];

  private running = false;

  constructor(config: SDKConfig) {
    super();

    // Create engine (this initializes all subsystems)
    this.engine = new LodestoneEngine(config);
    this.log = getLogger('sdk');

    // Create plugin manager
    this.pluginManager = new PluginManager({
      workspaceRoot: config.workspaceRoot,
      getToolDefinitions: () => this.engine.tools.listDefinitions(),
      logger: this.log,
    });

    // Wire plugin custom events into the SDK event stream
    this.pluginManager.onCustomEvent((event) => {
      this.emit('plugin.custom', event);
      this.emit('sdk.event', { type: 'plugin.custom', event } satisfies SDKEvent);
    });

    // Wire engine events into the SDK event stream
    this.engine.onEvent((event) => {
      this.emit('engine.event', event);
      this.emit('sdk.event', event satisfies SDKEvent);
    });

    // ─── Tools Namespace ──────────────────────────────────────────────────

    this.tools = {
      register: (tool: Tool) => this.engine.registerTool(tool),
      get: (toolId: string) => this.engine.tools.get(toolId),
      list: () => this.engine.tools.listDefinitions(),
      execute: (toolId: string, params: Record<string, unknown>, context: ToolContext) =>
        this.engine.tools.execute(toolId, params, context),
    };

    // ─── Channels Namespace ───────────────────────────────────────────────

    this.channels = {
      manager: this.engine.channelManager,
      list: () => {
        const mgr = this.engine.channelManager;
        if (!mgr) return [];
        return mgr.listChannels().map(ch => ch.id);
      },
    };

    // ─── Memory Namespace ────────────────────────────────────────────────

    this.memory = {
      store: async (key: string, value: string, metadata?: Record<string, unknown>) => {
        await this.engine.memory.vector.store(key, value, metadata);
      },
      recall: async (query: string, limit?: number) => {
        const results = await this.engine.memory.vector.recall(query, limit);
        return results.map(r => ({
          text: r.text,
          relevance: r.relevance,
          timestamp: r.timestamp,
        }));
      },
      wikiRead: (slug: string) => this.engine.memory.wiki.read(slug),
      wikiWrite: (slug: string, content: string, frontmatter?: Record<string, unknown>) =>
        this.engine.memory.wiki.write(slug, content, frontmatter as Partial<import('./memory/wiki-store.js').WikiFrontmatter> | undefined),
      wikiSearch: (query: string, limit?: number) =>
        this.engine.memory.wiki.search(query, limit),
      scratchGet: (key: string) => this.engine.memory.scratch.scratchGet(key),
      scratchSet: (key: string, value: string, ttlMs?: number) =>
        this.engine.memory.scratch.scratchSet(key, value, ttlMs),
    };

    // ─── Safety Namespace ─────────────────────────────────────────────────

    this.safety = {
      canAutoApprove: (toolId: string) => this.engine.safety.canAutoApprove(toolId),
      canRunInSleep: (toolId: string) => this.engine.safety.canRunInSleep(toolId),
      getRules: () => this.engine.safety.getRulesForPrompt(),
      simulate: (toolId: string, params: Record<string, unknown>) => {
        const result = this.engine.safety.simulate(toolId, params);
        return {
          approved: result.approved,
          riskLevel: result.riskLevel,
          predictedOutcome: result.predictedOutcome,
        };
      },
    };

    // ─── Plugins Namespace ─────────────────────────────────────────────────

    this.plugins = {
      list: () => this.pluginManager.list(),
      get: (pluginId: string) => this.pluginManager.get(pluginId),
      count: () => this.pluginManager.count(),
      register: async (plugin: Plugin, config?: Record<string, unknown>) => {
        await this.pluginManager.register(plugin, config);
      },
      unregister: async (pluginId: string) => {
        await this.pluginManager.unregister(pluginId);
      },
    };
  }

  // ─── Middleware ─────────────────────────────────────────────────────────

  /**
   * Add request middleware. Middleware runs in order before processing
   * a message. Each middleware can modify the request or short-circuit.
   */
  useRequestMiddleware(fn: MiddlewareFn<SDKRequest>): void {
    this.requestMiddleware.push(fn);
  }

  /**
   * Add response middleware. Middleware runs in order after generating
   * a response, before it's sent to the user.
   */
  useResponseMiddleware(fn: MiddlewareFn<SDKResponse>): void {
    this.responseMiddleware.push(fn);
  }

  /**
   * Run request middleware chain. Returns the (possibly modified) request.
   */
  private async runRequestMiddleware(request: SDKRequest): Promise<SDKRequest> {
    let result = request;
    for (const fn of this.requestMiddleware) {
      result = await fn(result, async () => result);
    }
    return result;
  }

  /**
   * Run response middleware chain. Returns the (possibly modified) response.
   */
  private async runResponseMiddleware(response: SDKResponse): Promise<SDKResponse> {
    let result = response;
    for (const fn of this.responseMiddleware) {
      result = await fn(result, async () => result);
    }
    return result;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the agent — init engine, register plugins, begin listening.
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.emit('sdk.event', { type: 'sdk.starting', timestamp: new Date().toISOString() } satisfies SDKEvent);

    // Start engine
    await this.engine.start();

    // Register plugins from config
    const config = this.engine.config as SDKConfig;
    if (config.plugins) {
      for (const { plugin, config: pluginConfig } of config.plugins) {
        await this.pluginManager.register(plugin, pluginConfig);
      }
    }

    this.running = true;
    this.emit('sdk.event', { type: 'sdk.started', timestamp: new Date().toISOString() } satisfies SDKEvent);
    this.log.info('SDK started');
  }

  /**
   * Stop the agent — unregister plugins, stop engine.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.emit('sdk.event', { type: 'sdk.stopping', timestamp: new Date().toISOString() } satisfies SDKEvent);

    // Unregister all plugins
    await this.pluginManager.unregisterAll();

    // Stop engine
    await this.engine.stop();

    this.running = false;
    this.emit('sdk.event', { type: 'sdk.stopped', timestamp: new Date().toISOString() } satisfies SDKEvent);
    this.log.info('SDK stopped');
  }

  /** Is the SDK running? */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Session Management ──────────────────────────────────────────────────

  /**
   * Create a new session. Returns the session ID.
   */
  createSession(contextWindow?: number): string {
    return this.engine.createSession(contextWindow);
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.engine.sessions.get(sessionId);
  }

  // ─── Message Processing ──────────────────────────────────────────────────

  /**
   * Process a message through the full pipeline:
   * request middleware → plugin hooks → engine → response middleware → plugin hooks
   *
   * This is the main entry point for applications sending messages to the agent.
   */
  async processMessage(sessionId: string, content: string, sender?: { id: string; name: string }): Promise<SDKResponse> {
    // Build the request
    const request: SDKRequest = {
      sessionId,
      content,
      senderId: sender?.id ?? 'sdk-user',
      senderName: sender?.name ?? 'SDK User',
      timestamp: new Date().toISOString(),
    };

    // Run request middleware
    const processedRequest = await this.runRequestMiddleware(request);

    // Execute plugin onMessage hook
    await this.pluginManager.executeHook({
      hook: 'onMessage',
      sessionId,
      timestamp: processedRequest.timestamp,
      payload: {
        content: processedRequest.content,
        senderId: processedRequest.senderId,
        senderName: processedRequest.senderName,
        channelId: 'sdk',
      },
    });

    // Emit event
    this.emit('message.received', processedRequest);
    this.emit('sdk.event', {
      type: 'message.received',
      sessionId,
      content: processedRequest.content,
    } satisfies SDKEvent);

    // Execute plugin beforeResponse hook (before engine processes)
    const beforeResult = await this.pluginManager.executeHook({
      hook: 'beforeResponse',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        content: processedRequest.content,
        toolCalls: [],
      },
    });

    // If a plugin blocked the response
    if (beforeResult.action === 'block') {
      const response: SDKResponse = {
        sessionId,
        content: `Response blocked: ${beforeResult.blockReason}`,
        toolCalls: [],
        durationMs: 0,
        blocked: true,
        blockReason: beforeResult.blockReason,
      };
      this.emit('message.sent', response);
      return response;
    }

    // Process through the engine's session manager
    // The actual LLM interaction is handled by the engine's agent loop.
    // Here we add the message to the session and return a structured response.
    const startTime = Date.now();

    // Add the message to the session
    const session = this.engine.sessions.get(sessionId);
    if (session) {
      this.engine.sessions.addMessage(sessionId, {
        role: 'user',
        content: processedRequest.content,
      });
    }

    const response: SDKResponse = {
      sessionId,
      content: processedRequest.content,
      toolCalls: [],
      durationMs: Date.now() - startTime,
      blocked: false,
    };

    // Run response middleware
    const processedResponse = await this.runResponseMiddleware(response);

    // Execute plugin afterResponse hook
    await this.pluginManager.executeHook({
      hook: 'afterResponse',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        content: processedResponse.content,
        toolCalls: processedResponse.toolCalls,
        durationMs: processedResponse.durationMs,
      },
    });

    // Emit event
    this.emit('message.sent', processedResponse);
    this.emit('sdk.event', {
      type: 'message.sent',
      sessionId,
      content: processedResponse.content,
    } satisfies SDKEvent);

    return processedResponse;
  }

  // ─── Tool Hook Helpers ──────────────────────────────────────────────────

  /**
   * Execute the beforeTool plugin hook. Called by the agent loop before
   * executing a tool. Returns whether to proceed and any modified params.
   */
  async beforeTool(
    sessionId: string,
    toolId: string,
    params: Record<string, unknown>,
  ): Promise<{ proceed: boolean; modifiedParams?: Record<string, unknown>; blockReason?: string }> {
    const result = await this.pluginManager.executeHook({
      hook: 'beforeTool',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { toolId, params },
    });

    if (result.action === 'block') {
      return { proceed: false, blockReason: result.blockReason };
    }

    if (result.action === 'modify' && result.modifiedPayload) {
      const modified = result.modifiedPayload as { toolId: string; params: Record<string, unknown> };
      return { proceed: true, modifiedParams: modified.params };
    }

    return { proceed: true };
  }

  /**
   * Execute the afterTool plugin hook. Called by the agent loop after
   * a tool executes. Returns the (possibly modified) result.
   */
  async afterTool(
    sessionId: string,
    toolId: string,
    params: Record<string, unknown>,
    result: ToolResult,
  ): Promise<ToolResult> {
    const hookResult = await this.pluginManager.executeHook({
      hook: 'afterTool',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { toolId, params, result },
    });

    if (hookResult.action === 'modify' && hookResult.modifiedPayload) {
      const modified = hookResult.modifiedPayload as { toolId: string; params: Record<string, unknown>; result: ToolResult };
      return modified.result;
    }

    return result;
  }
}

// ─── SDK Request / Response Types ──────────────────────────────────────────

export interface SDKRequest {
  sessionId: string;
  content: string;
  senderId: string;
  senderName: string;
  timestamp: string;
}

export interface SDKResponse {
  sessionId: string;
  content: string;
  toolCalls: { toolId: string; params: Record<string, unknown> }[];
  durationMs: number;
  blocked: boolean;
  blockReason?: string;
}

// ─── Factory Function ──────────────────────────────────────────────────────

/**
 * Create a Lodestone agent instance. This is the main entry point for
 * application developers.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   llm: { default: { provider: 'ollama', model: 'llama3' } },
 *   workspaceRoot: './workspace',
 *   identityDir: './identity',
 *   wikiRoot: './wiki',
 *   memoryDir: './data/memory',
 *   plugins: [{ plugin: myPlugin, config: { debug: true } }],
 * });
 *
 * agent.on('sdk.event', (event) => console.log(event));
 * await agent.start();
 * const response = await agent.processMessage(sessionId, "Hello!");
 * await agent.stop();
 * ```
 */
export function createAgent(config: SDKConfig): LodestoneSDK {
  return new LodestoneSDK(config);
}
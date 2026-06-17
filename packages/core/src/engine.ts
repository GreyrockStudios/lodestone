/**
 * Lodestone Core — Main Engine
 *
 * The orchestrator. Wires together LLM, tools, memory, identity,
 * session management, and scheduling into a running agent.
 */

import { LLMRouter, LLMProvider, type ProviderConfig, type ModelRoute } from './llm/provider.js';
import { ToolRegistry, type Tool, type ToolContext } from './tools/definitions.js';
import { SessionManager } from './session/manager.js';
import { StreamHandler } from './streaming/handler.js';
import { Scheduler, type JobConfig } from './scheduler/scheduler.js';
import { IdentityLoader, type Identity, type IdentityConfig } from './identity/loader.js';
import { MemorySystem } from './memory/memory-system.js';
import { ImprovementSystem, type ImprovementConfig } from './improvement/index.js';
import { ChannelManager, type ChannelManagerConfig } from './channels/index.js';
import { SafetySystem, type SafetyConfig } from './safety/index.js';
import { join } from 'path';

// ─── Engine Config ─────────────────────────────────────────────────────────

export interface LodestoneConfig {
  /** LLM provider configuration */
  llm: {
    default: ProviderConfig;
    routes?: ModelRoute[];
  };
  /** Workspace root directory */
  workspaceRoot: string;
  /** Identity directory (contains SOUL.md, etc.) */
  identityDir: string;
  /** Wiki root directory */
  wikiRoot: string;
  /** Memory/vector DB directory */
  memoryDir: string;
  /** Maximum concurrent tool executions */
  maxConcurrentTools?: number;
  /** Maximum concurrent scheduled jobs */
  maxConcurrentJobs?: number;
  /** Session compaction threshold (0-1) */
  compactionThreshold?: number;
  /** Channel configuration */
  channels?: ChannelManagerConfig;
  /** Safety configuration (capability tiers, behavioral learning, memory promotion) */
  safety?: SafetyConfig;
}

// ─── Engine Events ──────────────────────────────────────────────────────────

export type EngineEvent =
  | { type: 'started'; timestamp: string }
  | { type: 'stopped'; timestamp: string }
  | { type: 'session.created'; sessionId: string }
  | { type: 'message.received'; sessionId: string; content: string }
  | { type: 'message.sent'; sessionId: string; content: string }
  | { type: 'tool.called'; sessionId: string; toolId: string }
  | { type: 'tool.completed'; sessionId: string; toolId: string; durationMs: number }
  | { type: 'memory.stored'; key: string }
  | { type: 'memory.recalled'; query: string; count: number }
  | { type: 'job.started'; jobId: string }
  | { type: 'job.completed'; jobId: string; status: string }
  | { type: 'error'; error: string; context?: string };

// ─── Lodestone Engine ──────────────────────────────────────────────────────

export class LodestoneEngine {
  readonly config: LodestoneConfig;

  // Core subsystems
  readonly llm: LLMRouter;
  readonly tools: ToolRegistry;
  readonly sessions: SessionManager;
  readonly scheduler: Scheduler;
  readonly identity: IdentityLoader;
  readonly safety: SafetySystem;

  readonly memory: MemorySystem;
  readonly improvement: ImprovementSystem;
  readonly channelManager: ChannelManager | null;

  // State
  private running = false;
  private eventHandlers: ((event: EngineEvent) => void)[] = [];

  constructor(config: LodestoneConfig) {
    this.config = config;

    // Initialize subsystems
    this.llm = new LLMRouter(config.llm.default, config.llm.routes);
    this.tools = new ToolRegistry();
    this.sessions = new SessionManager({
      thresholdPercent: config.compactionThreshold || 0.5,
    });
    this.scheduler = new Scheduler(config.maxConcurrentJobs || 4);
    this.memory = new MemorySystem({
      wiki: {
        rootDir: config.wikiRoot,
        autoIndex: true,
        autoLint: true,
        categories: ['entities', 'concepts', 'decisions', 'projects', 'areas', 'research'],
      },
      vector: {
        dbPath: config.memoryDir,
        embeddingProvider: 'ollama',
        embeddingModel: 'nomic-embed-text',
        dimensions: 768,
        recallMaxChars: 800,
        autoRecall: true,
        autoCapture: false,
      },
      scratch: {
        dbPath: join(config.workspaceRoot, 'data/scratch.json'),
        defaultTtlMs: null,
      },
    });
    this.identity = new IdentityLoader({
      identityDir: config.identityDir,
    });

    // Improvement subsystem
    this.improvement = new ImprovementSystem({
      dataDir: join(config.workspaceRoot, 'data/improvement'),
      sleepCycleEnabled: true,
    });

    // Safety subsystem
    this.safety = new SafetySystem({
      dataDir: join(config.workspaceRoot, 'data/safety'),
      customTiers: config.safety?.customTiers,
    });

    // Initialize channels (only if configured)
    this.channelManager = config.channels
      ? new ChannelManager(config.channels)
      : null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the engine — load identity, register tools, start scheduler */
  async start(): Promise<void> {
    if (this.running) return;

    console.log('[Lodestone] Starting engine...');

    // Load identity
    const loadedIdentity = await this.identity.load();
    console.log(`[Lodestone] Identity loaded: ${loadedIdentity.identity.name}`);

    // Initialize improvement subsystem
    await this.improvement.init();

    // Initialize safety subsystem
    await this.safety.init();

    // Register improvement tools
    for (const tool of this.improvement.getTools()) {
      this.tools.register(tool);
    }

    // Register sleep cycle job
    this.scheduler.register(this.improvement.getSleepCycleJob());

    // Start scheduler
    this.scheduler.on('job:start' as never, (data: { jobId: string; name: string }) => {
      this.emit({ type: 'job.started', jobId: data.jobId });
    });
    this.scheduler.on('job:complete' as never, (data: { jobId: string }) => {
      this.emit({ type: 'job.completed', jobId: data.jobId, status: 'ok' });
    });
    this.scheduler.on('job:error' as never, (data: { jobId: string; error: string }) => {
      this.emit({ type: 'job.completed', jobId: data.jobId, status: 'error' });
    });

    // Start channels (if configured)
    if (this.channelManager) {
      await this.channelManager.start();
    }

    this.running = true;
    this.emit({ type: 'started', timestamp: new Date().toISOString() });

    console.log('[Lodestone] Engine started. Agent is thinking.');
  }

  /** Stop the engine — cancel jobs, cleanup */
  async stop(): Promise<void> {
    if (!this.running) return;

    console.log('[Lodestone] Stopping engine...');

    // Stop channels
    if (this.channelManager) {
      await this.channelManager.stop();
    }

    this.scheduler.stopAll();
    this.running = false;

    this.emit({ type: 'stopped', timestamp: new Date().toISOString() });
    console.log('[Lodestone] Engine stopped.');
  }

  /** Is the engine running? */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Tool Registration ──────────────────────────────────────────────────

  /** Register a tool */
  registerTool(tool: Tool): void {
    this.tools.register(tool);
  }

  // ─── Job Registration ───────────────────────────────────────────────────

  /** Register a scheduled job */
  registerJob(config: JobConfig): void {
    this.scheduler.register(config);
  }

  // ─── Sessions ───────────────────────────────────────────────────────────

  /** Create a new session */
  createSession(contextWindow?: number): string {
    const session = this.sessions.create(contextWindow || this.llm.getDefault().getContextWindow());
    this.emit({ type: 'session.created', sessionId: session.id });
    return session.id;
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  /** Subscribe to engine events */
  onEvent(handler: (event: EngineEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /** Emit an engine event to all registered handlers */
  public emit(event: EngineEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[Lodestone] Event handler error:', err);
      }
    }
  }
}
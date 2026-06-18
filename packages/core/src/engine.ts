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
import { CostTracker, type TokenUsage, type CostReport, type SessionCost, type BudgetAlert, type BudgetStatus, type CostBreakdown, type CostExport } from './llm/cost-tracker.js';
import { ModelRouter, type RoutingContext, type RoutingDecision, type RoutingRule, type RoutingStats } from './llm/model-router.js';
import { WebhookSystem, type WebhookConfig, type OutgoingWebhookConfig } from './integrations/webhooks.js';
import { ABTesting, type ABTest, type PromptVariant, type ABOutcome, type ABResults, type SignificanceResult } from './improvement/ab-testing.js';
import { KnowledgeTransfer, type TransferPackage, type TransferItem, type ReceiveResult, type ApplyResult, type KnowledgeType } from './memory/knowledge-transfer.js';
import { UndoSystem, type UndoableAction, type UndoableActionType, type UndoResult, type ReverseHandler } from './safety/undo-system.js';
import { UserManager, type UserConfig, type User } from './auth/user-manager.js';
import { MigrationSystem } from './migration/migration-system.js';
import { DashboardServer, type DashboardConfig } from './dashboard/server.js';
import { ProactiveIntelligence, type ProactiveConfig } from './improvement/proactive-intelligence.js';
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
  /** Cost tracking configuration */
  costTracking?: { enabled: boolean; monthlyBudget?: number; pricing?: Record<string, { input: number; output: number }> };
  /** Multi-model routing configuration */
  modelRouting?: { enabled: boolean; routes?: RoutingRule[]; defaultModel: string; escalationModel: string; cheapModel?: string; mediumModel?: string; expensiveModel?: string };
  /** Webhook integration configuration */
  webhooks?: { incoming?: WebhookConfig[]; outgoing?: OutgoingWebhookConfig[] };
  /** A/B prompt testing configuration */
  abTesting?: { enabled: boolean };
  /** Email channel configuration */
  email?: { imap: { host: string; port: number; user: string; password: string; tls: boolean }; smtp: { host: string; port: number; user: string; password: string }; pollIntervalMs?: number };
  /** Calendar integration configuration */
  calendar?: { provider: 'caldav' | 'google'; url?: string; token?: string; calendarId?: string };
  /** Auth/multi-user configuration */
  auth?: { users: UserConfig[]; tokens: Record<string, string> };
  /** Dashboard configuration */
  dashboard?: DashboardConfig;
  /** Proactive intelligence configuration */
  proactive?: ProactiveConfig;
  /** Config version for migrations */
  configVersion?: number;
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
  // Sprint 5: LLM features
  readonly costTracker: CostTracker | null;
  readonly modelRouter: ModelRouter | null;
  // Sprint 5: Integrations
  readonly webhooks: WebhookSystem | null;
  readonly abTesting: ABTesting | null;
  // Sprint 6: Quality
  readonly knowledgeTransfer: KnowledgeTransfer | null;
  readonly undoSystem: UndoSystem | null;
  readonly userManager: UserManager | null;
  readonly migrationSystem: MigrationSystem;
  readonly dashboard: DashboardServer | null;
  readonly proactiveIntelligence: ProactiveIntelligence | null;

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
      behavioralLearning: config.safety?.behavioralLearning,
      memoryPromotion: config.safety?.memoryPromotion,
      intentPrediction: config.safety?.intentPrediction,
      qualityGate: config.safety?.qualityGate,
    });

    // Initialize channels (only if configured)
    this.channelManager = config.channels
      ? new ChannelManager(config.channels)
      : null;

    // Sprint 5: Cost tracking
    this.costTracker = config.costTracking?.enabled
      ? new CostTracker({
          dataDir: join(config.workspaceRoot, 'data'),
          pricing: config.costTracking?.pricing,
        })
      : null;

    // Sprint 5: Multi-model routing
    this.modelRouter = config.modelRouting?.enabled
      ? new ModelRouter(config.modelRouting)
      : null;

    // Sprint 5: Webhook system
    this.webhooks = config.webhooks
      ? new WebhookSystem(config.webhooks)
      : null;

    // Sprint 5: A/B testing
    this.abTesting = config.abTesting?.enabled
      ? new ABTesting(join(config.workspaceRoot, 'data'))
      : null;

    // Sprint 6: Knowledge transfer (always on, lightweight)
    this.knowledgeTransfer = new KnowledgeTransfer(join(config.workspaceRoot, 'data'));

    // Sprint 6: Undo system (always on)
    this.undoSystem = new UndoSystem(join(config.workspaceRoot, 'data'));

    // Sprint 6: Multi-user support
    this.userManager = config.auth
      ? new UserManager(join(config.workspaceRoot, 'data'))
      : null;

    // Sprint 6: Migration system
    this.migrationSystem = new MigrationSystem(join(config.workspaceRoot, 'data'));

    // Dashboard (only if configured)
    this.dashboard = config.dashboard
      ? new DashboardServer(config.dashboard)
      : null;

    // Proactive intelligence (only if configured)
    this.proactiveIntelligence = config.proactive
      ? new ProactiveIntelligence(config.proactive)
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

    // Sprint 5: Init cost tracker
    if (this.costTracker) await this.costTracker.init();

    // Sprint 6: Run migrations
    await this.migrationSystem!.runMigrations();

    // Sprint 6: Load users
    if (this.userManager) await this.userManager.init();

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

    // Start dashboard (if configured)
    if (this.dashboard) {
      // Register engine data providers
      this.dashboard.registerProvider('engine', async () => ({
        running: this.running,
        sessions: this.sessions.list().length,
        tools: this.tools.listDefinitions().length,
        scheduledJobs: this.scheduler.list().length,
      }));
      this.dashboard.registerProvider('safety', async () => ({
        capabilities: this.safety.capabilities.getTierSummary(),
        behavioralRules: this.safety.behavioralLearning.getActiveRules().length,
        intentStats: this.safety.intentPredictor.getStats(),
        qualityGate: this.safety.qualityGate.getStatus(),
        memoryPromotionQueue: this.safety.memoryPromotion.listQueue(),
      }));
      this.dashboard.registerProvider('improvement', async () => ({
        predictions: await this.improvement.predictionJournal.list({ limit: 10 }),
        latestDrift: await this.improvement.driftDetector.getLatest(),
        latestDiagnosis: await this.improvement.rbtDiagnosis.getLatest(),
      }));
      this.dashboard.registerProvider('memory', async () => ({
        wikiPages: (await this.memory.wiki.list()).length,
        scratchKeys: this.memory.scratch.list(),
      }));
      this.dashboard.registerProvider('proactive', async () => {
        if (!this.proactiveIntelligence) return { opportunities: [] };
        const result = await this.proactiveIntelligence.check();
        return { opportunities: result.opportunities, lastCheck: result.timestamp };
      });

      await this.dashboard.start();
      console.log(`[Lodestone] Dashboard started on port ${this.config.dashboard?.port}`);
    }

    // Init proactive intelligence (if configured)
    if (this.proactiveIntelligence) {
      await this.proactiveIntelligence.init();
      const checkIntervalMs = this.config.proactive?.checkIntervalMs || 30 * 60 * 1000;
      this.scheduler.register({
        id: 'proactive-check',
        name: 'Proactive Intelligence Check',
        schedule: { kind: 'interval', everyMs: checkIntervalMs },
        description: 'Scan for proactive opportunities',
      });
      console.log('[Lodestone] Proactive intelligence initialized');
    }

    this.running = true;
    this.emit({ type: 'started', timestamp: new Date().toISOString() });

    console.log('[Lodestone] Engine started. Agent is thinking.');
  }

  /** Stop the engine — cancel jobs, cleanup */
  async stop(): Promise<void> {
    if (!this.running) return;

    console.log('[Lodestone] Stopping engine...');

    // Stop dashboard
    if (this.dashboard) {
      await this.dashboard.stop();
      console.log('[Lodestone] Dashboard stopped.');
    }

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
        // eslint-disable-next-line no-console -- event handler errors need to be visible
        console.error('[Lodestone] Event handler error:', err);
      }
    }
  }
}
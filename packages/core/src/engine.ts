/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
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
import { ConfigWatcher } from './utils/config-watcher.js';
import { ContextualStyle, type StyleProfile, type StyleContext } from './identity/contextual-style.js';
import { ConfidenceDisplay } from './safety/confidence-display.js';
import { FailureReplay, type FailureReplayConfig } from './safety/failure-replay.js';
import { SelfConstraints, type SelfConstraintsConfig } from './safety/self-constraints.js';
import { SkillSynthesizer, type SkillSynthesizerConfig } from './improvement/skill-synthesizer.js';
import { ExplainabilityLayer } from './safety/explainability.js';
import { MemorySystem } from './memory/memory-system.js';
import { ImprovementSystem, type ImprovementConfig } from './improvement/index.js';
import { MultiAgentCoordinator } from './improvement/multi-agent.js';
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
import type { CalibrationInsight } from './improvement/calibration-loop.js';
import type { DriftCorrection } from './improvement/drift-correction.js';
import { PluginManager, type Plugin, type PluginHookName } from './plugin-system.js';
import { SessionPersistence } from './session/persistence.js';
import { join } from 'path';
import { getLogger, type Logger } from './utils/logger.js';

// ─── Engine Config ─────────────────────────────────────────────────────────

export interface LodestoneConfig {
  /** Path to config file (for hot-reload via ConfigWatcher) */
  configPath?: string;
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
  /** Embedding provider override (default: ollama) */
  embeddingProvider?: string;
  /** Embedding model override (default: nomic-embed-text) */
  embeddingModel?: string;
  /** Embedding dimensions override (default: 768) */
  embeddingDimensions?: number;
  /** Auto-capture setting override (default: true) */
  autoCapture?: boolean;
  /** Maximum concurrent tool executions */
  maxConcurrentTools?: number;
  /** Maximum concurrent scheduled jobs */
  maxConcurrentJobs?: number;
  /** Session compaction threshold (0-1) */
  compactionThreshold?: number;
  /** Session config: keep recent messages count */
  sessionKeepRecentCount?: number;
  /** Session config: max message entries */
  sessionMaxEntries?: number;
  /** Session config: prune after duration string (e.g. '7d') */
  sessionPruneAfter?: string;
  /** Scratch buffer path */
  scratchPath?: string;
  /** Auto-recall from vector DB (default: true) */
  autoRecall?: boolean;
  /** Logging configuration */
  logging?: { level?: string; file?: string; format?: string };
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
  | { type: 'heartbeat'; context: string }
  | { type: 'error'; error: string; context?: string };

// AgentLoop type (avoid circular import)
export interface AgentLoopLike {
  run(sessionId: string, userMessage: string, streamHandler?: unknown): Promise<{ response: string; toolCalls: unknown[]; totalTokens: number; rounds: number }>;
}

// ─── Lodestone Engine ──────────────────────────────────────────────────────

export class LodestoneEngine {
  readonly config: LodestoneConfig;

  // Core subsystems
  readonly llm: LLMRouter;
  readonly tools: ToolRegistry;
  readonly sessions: SessionManager;
  readonly scheduler: Scheduler;
  readonly identity: IdentityLoader;
  readonly contextualStyle: ContextualStyle;
  readonly confidenceDisplay: ConfidenceDisplay;
  readonly failureReplay: FailureReplay;
  readonly selfConstraints: SelfConstraints;
  readonly skillSynthesizer: SkillSynthesizer;
  readonly explainability: ExplainabilityLayer;
  readonly configWatcher: ConfigWatcher | null;
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
  private lastCalibrationInsights: CalibrationInsight[] = [];
  private lastDriftCorrections: DriftCorrection[] = [];
  readonly pluginManager: PluginManager;
  private agentLoop: AgentLoopLike | null = null;
  sessionPersistence: SessionPersistence | null;

  // State
  private running = false;
  private eventHandlers: ((event: EngineEvent) => void)[] = [];
  private logger = getLogger('Engine');

  constructor(config: LodestoneConfig) {
    this.config = config;

    // Initialize subsystems
    this.llm = new LLMRouter(config.llm.default, config.llm.routes);
    this.tools = new ToolRegistry();
    this.sessions = new SessionManager({
      thresholdPercent: config.compactionThreshold || 0.5,
      keepRecentCount: config.sessionKeepRecentCount,
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
        embeddingProvider: (config.embeddingProvider as 'ollama' | 'openai') || 'ollama',
        embeddingModel: config.embeddingModel || 'nomic-embed-text',
        dimensions: config.embeddingDimensions || 768,
        recallMaxChars: 800,
        autoRecall: config.autoRecall ?? true,
        autoCapture: config.autoCapture ?? true,
      },
      scratch: {
        dbPath: config.scratchPath || join(config.workspaceRoot, 'data/scratch.json'),
        defaultTtlMs: null,
      },
    });
    this.identity = new IdentityLoader({
      identityDir: config.identityDir,
    });
    this.contextualStyle = new ContextualStyle();
    this.confidenceDisplay = new ConfidenceDisplay();
    this.failureReplay = new FailureReplay({
      dataDir: join(config.workspaceRoot, 'data/failure-replay'),
      logger: getLogger() as Logger,
    });
    this.selfConstraints = new SelfConstraints({
      dataDir: join(config.workspaceRoot, 'data/self-constraints'),
    });
    this.skillSynthesizer = new SkillSynthesizer({
      dataDir: join(config.workspaceRoot, 'data/skill-synthesizer'),
    });
    this.explainability = new ExplainabilityLayer();

    // Config watcher — hot-reload config when the file changes (if path provided)
    this.configWatcher = config.configPath
      ? new ConfigWatcher({ path: config.configPath })
      : null;

    // Safety subsystem
    this.safety = new SafetySystem({
      dataDir: join(config.workspaceRoot, 'data/safety'),
      customTiers: config.safety?.customTiers,
      behavioralLearning: config.safety?.behavioralLearning,
      memoryPromotion: config.safety?.memoryPromotion,
      intentPrediction: config.safety?.intentPrediction,
      qualityGate: config.safety?.qualityGate,
    });

    // Improvement subsystem (after safety so it can reference behavioralLearning)
    this.improvement = new ImprovementSystem({
      dataDir: join(config.workspaceRoot, 'data/improvement'),
      sleepCycleEnabled: true,
      sessionManager: this.sessions,
      behavioralLearning: this.safety.behavioralLearning,
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

    // Session persistence (optional — requires better-sqlite3)
    this.sessionPersistence = null; // Will be initialized in start() if available

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

    // Plugin system
    this.pluginManager = new PluginManager({
      workspaceRoot: config.workspaceRoot,
      getToolDefinitions: () => this.tools.listDefinitions(),
      logger: getLogger('plugin-manager'),
    });
  }

  // ─── Convenience Accessors ──────────────────────────────────────────────

  /** Access the multi-agent coordinator for spawning sub-agents */
  get coordinator(): MultiAgentCoordinator {
    return this.improvement.multiAgent;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the engine — load identity, register tools, start scheduler */
  async start(): Promise<void> {
    if (this.running) return;

    this.logger.info('Starting engine...');

    // Load identity
    const loadedIdentity = await this.identity.load();
    this.logger.info('Identity loaded', { name: loadedIdentity.identity.name });

    // Initialize improvement subsystem
    await this.improvement.init();

    // Initialize safety subsystem
    await this.safety.init();

    // Initialize improvement subsystem modules that need async init
    await this.failureReplay.init();
    await this.selfConstraints.init();
    await this.skillSynthesizer.init();

    // Sprint 5: Init cost tracker
    if (this.costTracker) await this.costTracker.init();

    // Try to initialize session persistence (optional, requires better-sqlite3)
    try {
      const persistence = new SessionPersistence(join(this.config.workspaceRoot, 'data/sessions'));
      this.sessionPersistence = persistence;
      this.logger.info('Session persistence enabled (SQLite)');
    } catch {
      this.logger.info('Session persistence disabled (better-sqlite3 not available)');
    }

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
    this.scheduler.on('job:start' as never, async (data: { jobId: string; name: string }) => {
      this.emit({ type: 'job.started', jobId: data.jobId });
      await this.handleScheduledJob(data.jobId);
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
        calibrationInsights: this.lastCalibrationInsights,
        driftCorrections: this.lastDriftCorrections,
        abTests: this.improvement.abTesting.getActiveTests(),
      }));
      this.dashboard.registerProvider('memory', async () => ({
        wikiPages: (await this.memory.wiki.list()).length,
        scratchKeys: await this.memory.scratch.list(),
        compounding: this.memory.getCompoundingStats(),
        knowledgeGraph: this.memory.knowledgeGraph.getStats(),
      }));
      this.dashboard.registerProvider('proactive', async () => {
        if (!this.proactiveIntelligence) return { opportunities: [] };
        const result = await this.proactiveIntelligence.check();
        return { opportunities: result.opportunities, lastCheck: result.timestamp };
      });

      // Channel health provider
      if (this.channelManager) {
        this.dashboard.registerProvider('channels', async () => {
          return this.channelManager!.checkHealth();
        });
      }

      await this.dashboard.start();
      this.logger.info('Dashboard started', { port: this.config.dashboard?.port });
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
      this.logger.info('Proactive intelligence initialized');
    }

    // Register weekly memory growth report job
    if (this.memory.compounding) {
      this.scheduler.register({
        id: 'memory-growth-report',
        name: 'Weekly Memory Growth Report',
        schedule: { kind: 'cron', expr: '0 9 * * 1' }, // Monday 9am
        description: 'Generate weekly memory compounding growth report',
      });
      this.logger.info('Memory compounding growth report job registered');
    }

    // Register calibration loop job — runs hourly to resolve predictions and adjust confidence
    this.scheduler.register({
      id: 'calibration-loop',
      name: 'Calibration Loop',
      schedule: { kind: 'interval', everyMs: 60 * 60 * 1000 }, // 1 hour
      description: 'Auto-resolve predictions, compute calibration metrics, adjust confidence',
    });
    this.logger.info('Calibration loop job registered');

    // Register drift correction job — runs every 6 hours to detect and correct behavior drift
    this.scheduler.register({
      id: 'drift-correction',
      name: 'Drift Detection and Correction',
      schedule: { kind: 'interval', everyMs: 6 * 60 * 60 * 1000 }, // 6 hours
      description: 'Detect behavior drift from identity principles and generate corrective prompts',
    });
    this.logger.info('Drift correction job registered');

    // Register session cleanup job — runs hourly to remove stale sessions
    this.scheduler.register({
      id: 'session-cleanup',
      name: 'Session Cleanup',
      schedule: { kind: 'interval', everyMs: 60 * 60 * 1000 }, // 1 hour
      description: 'Remove sessions with no activity for 24+ hours',
    });
    this.logger.info('Session cleanup job registered');

    // Register dream mode job — runs nightly at 3am for reflective processing
    if (this.improvement.dreamMode) {
      this.scheduler.register({
        id: 'dream-mode',
        name: 'Dream Mode — Nightly Reflection',
        schedule: { kind: 'cron', expr: '0 3 * * *' }, // 3am daily
        description: 'Analyze recent conversations, extract behavioral rules, propose self-improvements',
      });
      this.logger.info('Dream mode job registered');
    }

    // Start config watcher (if configured) — hot-reload config on file change
    if (this.configWatcher) {
      this.configWatcher.onReload((newConfig) => {
        this.logger.info('Config reloaded', { llm: newConfig.llm?.default?.model });
        // Update what we safely can at runtime
        if (newConfig.maxConcurrentJobs) {
          // Scheduler maxConcurrent is set at construction time; config changes take effect on restart
        }
        if (newConfig.maxConcurrentTools) {
          this.config.maxConcurrentTools = newConfig.maxConcurrentTools;
        }
        // Note: LLM provider changes require restart — just log
        if (newConfig.llm?.default?.model !== this.config.llm.default.model) {
          this.logger.warn('LLM model changed — restart required to take effect', {
            from: this.config.llm.default.model,
            to: newConfig.llm.default.model,
          });
        }
      });
      this.configWatcher.start();
      this.logger.info('Config watcher started', { path: this.config.configPath });
    }

    this.running = true;
    this.emit({ type: 'started', timestamp: new Date().toISOString() });

    this.logger.info('Engine started. Agent is thinking.');
  }

  /** Stop the engine — cancel jobs, cleanup */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.logger.info('Stopping engine...');

    // Unregister all plugins
    await this.pluginManager.unregisterAll();

    // Stop dashboard
    if (this.dashboard) {
      await this.dashboard.stop();
      this.logger.info('Dashboard stopped.');
    }

    // Stop channels
    if (this.channelManager) {
      await this.channelManager.stop();
    }

    this.scheduler.stopAll();

    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.stop();
    }

    this.running = false;

    this.emit({ type: 'stopped', timestamp: new Date().toISOString() });
    this.logger.info('Engine stopped.');
  }

  /** Handle a scheduled job by ID */
  private async handleScheduledJob(jobId: string): Promise<void> {
    try {
      switch (jobId) {
        case 'calibration-loop': {
          const result = await this.improvement.calibrationLoop.run();
          this.logger.info('Calibration loop complete', {
            expired: result.expiredCount,
            resolved: result.resolvedCount,
            insights: result.insights.length,
          });
          // Store insights for the agent loop to use
          this.lastCalibrationInsights = result.insights;
          break;
        }
        case 'drift-correction': {
          const result = await this.improvement.driftCorrector.checkAndCorrect();
          this.logger.info('Drift correction complete', {
            corrections: result.corrections.length,
            overallDrift: result.overallDrift,
          });
          // Store corrections for the agent loop to use
          this.lastDriftCorrections = result.corrections;
          break;
        }
        case 'proactive-check': {
          if (this.proactiveIntelligence) {
            const result = await this.proactiveIntelligence.check();
            this.logger.info('Proactive check complete', { opportunities: result.opportunities.length });
          }
          break;
        }
        case 'memory-growth-report': {
          if (this.memory.compounding) {
            const report = this.memory.compounding.generateGrowthReport();
            this.logger.info('Memory growth report', {
              pages: report.wikiPages,
              entities: report.totalEntities,
              thinAreas: report.thinAreas.length,
            });
          }
          break;
        }
        case 'dream-mode': {
          if (this.improvement.dreamMode) {
            const report = await this.improvement.dreamMode.runDreamSession();
            this.logger.info('Dream mode complete', {
              sessionsReviewed: report.sessionsReviewed,
              responsesScored: report.responsesScored,
              learnings: report.learnings.length,
            });
          }
          break;
        }
        case 'session-cleanup': {
          const removed = this.sessions.cleanupStale();
          if (removed > 0) {
            this.logger.info('Session cleanup', { removed, remaining: this.sessions.count() });
          }
          break;
        }
        default:
          // Unknown job — skip
          break;
      }
    } catch (err) {
      this.logger.error('Scheduled job failed', { jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Get recent calibration insights for the agent loop */
  getCalibrationInsights(): CalibrationInsight[] {
    return this.lastCalibrationInsights || [];
  }

  /** Get recent drift corrections for the agent loop */
  getDriftCorrections(): DriftCorrection[] {
    return this.lastDriftCorrections || [];
  }

  /** Is the engine running? */
  isRunning(): boolean {
    return this.running;
  }

  /** Set the agent loop (called by main.ts or SDK after creating AgentLoop) */
  setAgentLoop(loop: AgentLoopLike): void {
    this.agentLoop = loop;
  }

  /** Get the agent loop (if set) */
  getAgentLoop(): AgentLoopLike | null {
    return this.agentLoop;
  }

  /** Process a message through the agent loop (convenience method) */
  async processMessage(sessionId: string, content: string): Promise<{ response: string; toolCalls: unknown[]; totalTokens: number; rounds: number }> {
    if (!this.agentLoop) {
      throw new Error('Agent loop not set. Call engine.setAgentLoop() before calling processMessage().');
    }
    return this.agentLoop.run(sessionId, content);
  }

  // ─── Tool Registration ──────────────────────────────────────────────────

  /** Register a tool */
  registerTool(tool: Tool): void {
    this.tools.register(tool);
  }

  // ─── Plugin Registration ─────────────────────────────────────────────────

  /** Register a plugin with the engine's plugin manager */
  async registerPlugin(plugin: Plugin, config: Record<string, unknown> = {}): Promise<void> {
    await this.pluginManager.register(plugin, config);
  }

  /** Execute a plugin hook at a given point in the lifecycle */
  async executePluginHook(
    hook: PluginHookName,
    sessionId: string,
    payload: unknown,
  ) {
    return this.pluginManager.executeHook({
      hook,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: payload as never,
    });
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
        this.logger.error('Event handler error', { error: err });
      }
    }
  }
}
/**
 * Lodestone Core — Public API
 *
 * This is the main entry point. Import from '@lodestone/core' to get
 * everything you need to create and run a Lodestone agent.
 */

// Engine
export { LodestoneEngine, type LodestoneConfig, type EngineEvent } from './engine.js';

// Boot + Config
export { bootEngine, type BootResult } from './boot.js';
export { loadConfigFromFile, type LoadConfigOptions } from './config-loader.js';

// Agent Loop
export { AgentLoop, type AgentLoopConfig, type AgentLoopResult, type ToolCallRecord } from './agent-loop.js';

// LLM
export { LLMProvider, LLMRouter, type ProviderConfig, type ProviderCapabilities, type ModelRoute } from './llm/provider.js';

// Memory
export { MemorySystem, type MemorySystemConfig } from './memory/memory-system.js';
export { WikiStore, type WikiPage, type WikiFrontmatter, type WikiSearchResult, type WikiConfig, type WikiLintIssue, type WikiLintReport } from './memory/wiki-store.js';
export { VectorMemory, type VectorMemoryConfig, type MemoryEntry } from './memory/vector-memory.js';
export { ScratchBuffer, type ScratchConfig, type ScratchEntry } from './memory/scratch-buffer.js';

// Tools
export { ToolRegistry, type Tool, type ToolDefinition, type ToolResult, type ToolContext, type MemoryAccess, type ToolLogger } from './tools/definitions.js';
export type { AgentIdentity as ToolAgentIdentity } from './tools/definitions.js';
export { WikiResolveTool } from './tools/impl/wiki-resolve.js';
export { WikiSearchTool } from './tools/impl/wiki-search.js';
export { SmartRetrieveTool } from './tools/impl/smart-retrieve.js';
export { DecisionLogTool, type DecisionEntry } from './tools/impl/decision-log.js';
export { ResumeStateTool } from './tools/impl/resume-state.js';
export { WatchdogTool, type WatchEntry } from './tools/impl/watchdog.js';
export { BusinessHoursTool, type BusinessHoursConfig } from './tools/impl/business-hours.js';
export { WebSearchTool, type WebSearchConfig } from './tools/impl/web-search.js';
export { WebFetchTool } from './tools/impl/web-fetch.js';
export { FileOpsTool, type FileOpsConfig } from './tools/impl/file-ops.js';
export { CodeExecTool, type CodeExecConfig } from './tools/impl/code-exec.js';
export { CalendarTool, type CalendarConfig } from './tools/impl/calendar.js';
export { VisionTool, type VisionToolConfig } from './tools/impl/vision.js';
export { VoiceTool, type VoiceToolConfig } from './tools/impl/voice.js';
export { CoordinatorTool } from './tools/impl/coordinator.js';
export { registerBuiltinTools, getBuiltinToolNames, getBuiltinJobNames } from './tools/register-builtin.js';

// Session
export { SessionManager, type Session, type SessionMessage, type SessionState, type CompactionConfig } from './session/manager.js';

// Streaming
export { StreamHandler, type StreamEvent, type StreamEventType, type StreamConfig } from './streaming/handler.js';

// Scheduler
export { Scheduler, type JobConfig, type JobResult, type JobState } from './scheduler/scheduler.js';

// Improvement
export { ImprovementSystem, type ImprovementConfig } from './improvement/index.js';
export { PredictionJournal, type PredictionEntry, type CalibrationReport, type CalibrationBucket } from './improvement/prediction-journal.js';
export { DriftDetector, type IdentityRule, type DecisionRecord, type DriftScore, type DriftReport } from './improvement/drift-detector.js';
export { RBTDiagnosis, type ActivityEntry, type RoseEntry, type BudEntry, type ThornEntry, type RBTReport } from './improvement/rbt-diagnosis.js';
export { SkillEvolver, type Lesson, type Skill, type EvolveResult } from './improvement/skill-evolver.js';
export { SleepCycle, type SleepStage, type SleepCycleResult, type HarvestResult, type MineResult, type ReflectionResult, type ConsolidationResult, type ValidationResult, type PreparationResult } from './improvement/sleep-cycle.js';
export { PredictionJournalTool, DriftCheckTool, RBTDiagnoseTool, SkillLearnTool } from './improvement/index.js';

// Safety
export { SafetySystem, type SafetyConfig } from './safety/index.js';
export { CapabilityManager, type CapabilityTier, type TierConfig, type SimulationResult } from './safety/capability-tiers.js';
export { BehavioralLearning, type BehavioralRule, type CorrectionInput, type BehavioralLearningConfig } from './safety/behavioral-learning.js';
export { MemoryPromotion, type VerificationLevel, type MemoryCandidate, type VerificationResult, type ConflictEntry, type MemoryPromotionConfig } from './safety/memory-promotion.js';

// Identity
export { IdentityLoader, type Identity, type AgentIdentity, type UserIdentity, type AgentRules, type HeartbeatState, type IdentityConfig } from './identity/loader.js';

// Channels
export { Channel, type ChannelConfig, type ChannelMessage, type MessageHandler } from './channels/channel.js';
export { TelegramChannel, type TelegramConfig } from './channels/telegram.js';
export { DiscordChannel, type DiscordConfig } from './channels/discord.js';
export { WebChatChannel, type WebChatConfig } from './channels/webchat.js';
export { ChannelManager, type ChannelManagerConfig } from './channels/manager.js';

// Utils — Error types
export { LodestoneError, LodestoneConfigError, LLMError, ToolError, ChannelError, MemoryError, SafetyError, isLodestoneError, errorMessage, errorContext } from './utils/errors.js';
export { ConfigValidator, type ConfigError, type ConfigWarning, type ConfigSchema, type ConfigField } from './utils/config-validator.js';

// Sprint 6: Knowledge Transfer
export { KnowledgeTransfer, type TransferPackage, type TransferItem, type ReceiveResult, type ApplyResult, type KnowledgeType } from './memory/knowledge-transfer.js';

// Sprint 6: Undo System
export { UndoSystem, type UndoableAction, type UndoableActionType, type UndoResult, type ReverseHandler } from './safety/undo-system.js';

// Sprint 6: Multi-User Auth
export { UserManager, type UserConfig, type User } from './auth/user-manager.js';
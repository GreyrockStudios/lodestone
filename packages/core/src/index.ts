/**
 * Lodestone Core — Public API
 *
 * This is the main entry point. Import from '@lodestone/core' to get
 * everything you need to create and run a Lodestone agent.
 */

// Engine
export { LodestoneEngine, type LodestoneConfig, type EngineEvent } from './engine.js';

// LLM
export { LLMProvider, LLMRouter, type ProviderConfig, type ProviderCapabilities, type ModelRoute } from './llm/provider.js';

// Memory
export { MemorySystem } from './memory/memory-system.js';
export { WikiStore } from './memory/wiki-store.js';
export { VectorMemory } from './memory/vector-memory.js';
export { ScratchBuffer } from './memory/scratch-buffer.js';

// Tools
export { ToolRegistry, type Tool, type ToolDefinition, type ToolResult, type ToolContext, type AgentIdentity, type MemoryAccess, type ToolLogger } from './tools/definitions.js';
export { WikiResolveTool, WikiSearchTool } from './tools/impl/wiki-resolve.js';
export { SmartRetrieveTool } from './tools/impl/smart-retrieve.js';
export { DecisionLogTool } from './tools/impl/decision-log.js';
export { ResumeStateTool } from './tools/impl/resume-state.js';
export { WatchdogTool } from './tools/impl/watchdog.js';
export { BusinessHoursTool } from './tools/impl/business-hours.js';

// Session
export { SessionManager, type Session, type SessionMessage, type SessionState, type CompactionConfig } from './session/manager.js';

// Streaming
export { StreamHandler, type StreamEvent, type StreamEventType, type StreamConfig } from './streaming/handler.js';

// Scheduler
export { Scheduler, type JobConfig, type JobResult, type JobState } from './scheduler/scheduler.js';

// Identity
export { IdentityLoader, type Identity, type AgentIdentity, type UserIdentity, type AgentRules, type HeartbeatState, type IdentityConfig } from './identity/loader.js';
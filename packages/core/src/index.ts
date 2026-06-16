/**
 * Lodestone Core — Public API
 *
 * This is the main entry point. Import from '@lodestone/core' to get
 * everything you need to create and run a Lodestone agent.
 */

// Engine
export { LodestoneEngine, type LodestoneConfig, type EngineEvent } from './engine.js';

// Agent Loop
export { AgentLoop, type AgentLoopConfig, type AgentLoopResult, type ToolCallRecord } from './agent-loop.js';

// LLM
export { LLMProvider, LLMRouter, type ProviderConfig, type ProviderCapabilities, type ModelRoute } from './llm/provider.js';

// Memory
export { MemorySystem, type MemorySystemConfig } from './memory/memory-system.js';
export { WikiStore, type WikiPage, type WikiFrontmatter, type WikiSearchResult, type WikiConfig } from './memory/wiki-store.js';
export { VectorMemory, type VectorMemoryConfig, type MemoryEntry } from './memory/vector-memory.js';
export { ScratchBuffer, type ScratchConfig, type ScratchEntry } from './memory/scratch-buffer.js';

// Tools
export { ToolRegistry, type Tool, type ToolDefinition, type ToolResult, type ToolContext, type MemoryAccess, type ToolLogger } from './tools/definitions.js';
export type { AgentIdentity as ToolAgentIdentity } from './tools/definitions.js';
export { WikiResolveTool, WikiSearchTool } from './tools/impl/wiki-resolve.js';
export { SmartRetrieveTool } from './tools/impl/smart-retrieve.js';
export { DecisionLogTool, type DecisionEntry } from './tools/impl/decision-log.js';
export { ResumeStateTool } from './tools/impl/resume-state.js';
export { WatchdogTool, type WatchEntry } from './tools/impl/watchdog.js';
export { BusinessHoursTool, type BusinessHoursConfig } from './tools/impl/business-hours.js';

// Session
export { SessionManager, type Session, type SessionMessage, type SessionState, type CompactionConfig } from './session/manager.js';

// Streaming
export { StreamHandler, type StreamEvent, type StreamEventType, type StreamConfig } from './streaming/handler.js';

// Scheduler
export { Scheduler, type JobConfig, type JobResult, type JobState } from './scheduler/scheduler.js';

// Identity
export { IdentityLoader, type Identity, type AgentIdentity, type UserIdentity, type AgentRules, type HeartbeatState, type IdentityConfig } from './identity/loader.js';
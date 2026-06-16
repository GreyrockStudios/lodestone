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

// Tools
export { ToolRegistry, type Tool, type ToolDefinition, type ToolResult, type ToolContext, type AgentIdentity, type MemoryAccess, type ToolLogger } from './tools/definitions.js';

// Session
export { SessionManager, type Session, type SessionMessage, type SessionState, type CompactionConfig } from './session/manager.js';

// Streaming
export { StreamHandler, type StreamEvent, type StreamEventType, type StreamConfig } from './streaming/handler.js';

// Scheduler
export { Scheduler, type JobConfig, type JobResult, type JobState } from './scheduler/scheduler.js';

// Identity
export { IdentityLoader, type Identity, type AgentIdentity, type UserIdentity, type AgentRules, type HeartbeatState, type IdentityConfig } from './identity/loader.js';
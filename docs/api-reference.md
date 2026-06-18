# Lodestone API Reference

> The complete SDK API for embedding Lodestone into your application.

## Table of Contents

- [createAgent()](#createagent)
- [LodestoneEngine](#lodestoneengine)
- [LodestoneConfig](#lodestoneconfig)
- [AgentLoop](#agentloop)
- [Tool Interface](#tool-interface)
- [Channel Interface](#channel-interface)
- [StreamHandler](#streamhandler)
- [SafetySystem](#safetysystem)
- [MemorySystem](#memorysystem)
- [ImprovementSystem](#improvementsystem)
- [PluginSystem](#pluginsystem)
- [Error Types](#error-types)
- [EventEmitter Patterns](#eventemitter-patterns)

---

## createAgent()

The main entry point. Creates a `LodestoneSDK` instance with all subsystems wired.

```typescript
import { createAgent } from '@lodestone/core';

const agent = createAgent({
  llm: {
    default: {
      type: 'ollama',
      model: 'glm-5.2:cloud',
      baseUrl: 'http://127.0.0.1:11434/api',
      contextWindow: 128000,
      maxTokens: 8192,
    },
  },
  workspaceRoot: './workspace',
  identityDir: './workspace',
  wikiRoot: './workspace/memory/wiki',
  memoryDir: './workspace/data/lancedb',
  channels: {
    channels: [
      { type: 'webchat', enabled: true, port: 3000 },
    ],
  },
  plugins: [{ plugin: myPlugin, config: { debug: true } }],
  autoStart: false,
});

await agent.start();
const sessionId = agent.createSession();
const response = await agent.processMessage(sessionId, 'Hello!');
await agent.stop();
```

### SDKConfig

Extends `LodestoneConfig` with SDK-specific options:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `plugins` | `{ plugin: Plugin; config?: Record<string, unknown> }[]` | `[]` | Plugins to register at startup |
| `autoStart` | `boolean` | `false` | Auto-start engine after creation |

### SDK Namespaces

The returned `LodestoneSDK` instance exposes:

| Namespace | Methods |
|-----------|---------|
| `agent.tools` | `register()`, `get()`, `list()`, `execute()` |
| `agent.channels` | `manager`, `list()` |
| `agent.memory` | `store()`, `recall()`, `wikiRead()`, `wikiWrite()`, `wikiSearch()`, `scratchGet()`, `scratchSet()` |
| `agent.safety` | `canAutoApprove()`, `canRunInSleep()`, `getRules()`, `simulate()` |
| `agent.plugins` | `list()`, `get()`, `count()`, `register()`, `unregister()` |

### Middleware

```typescript
// Modify requests before processing
agent.useRequestMiddleware(async (req, next) => {
  console.log(`[${req.senderName}] ${req.content}`);
  return next();
});

// Modify responses before sending
agent.useResponseMiddleware(async (res, next) => {
  res.content = res.content.replace(/TODO/g, '📋 TODO');
  return next();
});
```

---

## LodestoneEngine

The core orchestrator. Usually accessed via `sdk.engine`.

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `() => Promise<void>` | Load identity, init subsystems, register tools, start scheduler and channels |
| `stop()` | `() => Promise<void>` | Stop channels, cancel jobs, shutdown cleanly |
| `isRunning()` | `() => boolean` | Check if engine is running |
| `registerTool()` | `(tool: Tool) => void` | Register a custom tool |
| `registerJob()` | `(config: JobConfig) => void` | Register a scheduled job |
| `createSession()` | `(contextWindow?: number) => string` | Create a new session, returns session ID |
| `onEvent()` | `(handler: (event: EngineEvent) => void) => void` | Subscribe to engine events |
| `emit()` | `(event: EngineEvent) => void` | Emit an engine event |

### EngineEvent Types

```typescript
type EngineEvent =
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
```

---

## LodestoneConfig

Full configuration interface for the engine:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `llm` | `{ default: ProviderConfig; routes?: ModelRoute[] }` | ✅ | LLM provider configuration |
| `workspaceRoot` | `string` | ✅ | Workspace root directory |
| `identityDir` | `string` | ✅ | Directory with IDENTITY.md, SOUL.md, etc. |
| `wikiRoot` | `string` | ✅ | Wiki root directory |
| `memoryDir` | `string` | ✅ | Vector DB directory |
| `maxConcurrentTools` | `number` | ❌ | Max concurrent tool executions (default: unlimited) |
| `maxConcurrentJobs` | `number` | ❌ | Max concurrent scheduled jobs (default: 4) |
| `compactionThreshold` | `number` | ❌ | Session compaction threshold 0-1 (default: 0.5) |
| `channels` | `ChannelManagerConfig` | ❌ | Channel configuration |
| `safety` | `SafetyConfig` | ❌ | Safety system configuration |
| `costTracking` | `{ enabled: boolean; monthlyBudget?: number; pricing?: Record<string, { input: number; output: number }> }` | ❌ | Cost tracking |
| `modelRouting` | `{ enabled: boolean; routes?: RoutingRule[]; defaultModel: string; escalationModel: string; cheapModel?: string; mediumModel?: string; expensiveModel?: string }` | ❌ | Multi-model routing |
| `webhooks` | `{ incoming?: WebhookConfig[]; outgoing?: OutgoingWebhookConfig[] }` | ❌ | Webhook integrations |
| `abTesting` | `{ enabled: boolean }` | ❌ | A/B prompt testing |
| `email` | `{ imap: {...}; smtp: {...}; pollIntervalMs?: number }` | ❌ | Email channel |
| `calendar` | `{ provider: 'caldav' \| 'google'; url?: string; token?: string; calendarId?: string }` | ❌ | Calendar integration |
| `auth` | `{ users: UserConfig[]; tokens: Record<string, string> }` | ❌ | Multi-user auth |
| `configVersion` | `number` | ❌ | Config version for migrations |

### ProviderConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'ollama' \| 'openai' \| 'anthropic' \| 'custom'` | ✅ | Provider type |
| `model` | `string` | ✅ | Model identifier |
| `baseUrl` | `string` | ❌ | API endpoint (default: provider-specific) |
| `apiKey` | `string` | ❌ | API key (not needed for local Ollama) |
| `contextWindow` | `number` | ❌ | Context window size (default: 128000) |
| `maxTokens` | `number` | ❌ | Max output tokens (default: 8192) |
| `reasoning` | `boolean` | ❌ | Supports reasoning/thinking (default: false) |
| `headers` | `Record<string, string>` | ❌ | Custom headers |

---

## AgentLoop

The core execution cycle. Usually managed by the engine, but can be used directly:

```typescript
import { AgentLoop } from '@lodestone/core';

const loop = new AgentLoop(engine, {
  maxToolRounds: 10,
  maxTokens: 8192,
  temperature: 0.7,
  stream: true,
  autoRecall: true,
  autoCapture: false,
  maxRecallResults: 5,
  maxWikiChars: 2000,
  systemPromptTemplate: `{identity}\n\n{memories}\n\n{rules}`,
});

const result = await loop.run(sessionId, userMessage, streamHandler);
```

### AgentLoopConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxToolRounds` | `number` | `10` | Max tool call iterations per turn |
| `maxTokens` | `number` | `8192` | Max tokens for LLM response |
| `temperature` | `number` | `0.7` | LLM temperature |
| `stream` | `boolean` | `true` | Stream responses |
| `autoCapture` | `boolean` | `false` | Auto-store conversation summaries |
| `autoRecall` | `boolean` | `true` | Auto-recall relevant memories |
| `maxRecallResults` | `number` | `5` | Max memories to inject |
| `maxWikiChars` | `number` | `2000` | Max wiki content chars in prompt |
| `systemPromptTemplate` | `string` | `"{identity}\n\n{memories}\n\n{rules}"` | Prompt template with placeholders |

### AgentLoopResult

```typescript
interface AgentLoopResult {
  response: string;
  toolCalls: ToolCallRecord[];
  totalTokens: number;
  rounds: number;
  durationMs: number;
}
```

---

## Tool Interface

Create custom tools by implementing the `Tool` interface:

```typescript
import type { Tool, ToolResult, ToolContext } from '@lodestone/core';

const weatherTool: Tool = {
  definition: {
    id: 'weather',
    name: 'Weather Check',
    description: 'Get current weather for a city',
    parameters: [
      {
        name: 'city',
        description: 'City name',
        type: 'string',
        required: true,
      },
      {
        name: 'units',
        description: 'Temperature units',
        type: 'string',
        required: false,
        enum: ['celsius', 'fahrenheit'],
        default: 'celsius',
      },
    ],
    sideEffects: false,
    requiresApproval: false,
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const city = params.city as string;
    const units = (params.units as string) || 'celsius';

    try {
      const response = await fetch(`https://wttr.in/${city}?format=j1`);
      const data = await response.json();
      const temp = data.current_condition[0].temp_C;

      return {
        success: true,
        data: { city, temperature: temp, units },
        summary: `Weather in ${city}: ${temp}°${units === 'celsius' ? 'C' : 'F'}`,
        durationMs: 0,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Failed to get weather for ${city}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        includeInContext: true,
      };
    }
  },
};

// Register it
agent.tools.register(weatherTool);
// Or via engine
engine.registerTool(weatherTool);
```

### ToolDefinition Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✅ | Unique tool identifier (kebab-case) |
| `name` | `string` | ✅ | Human-readable name |
| `description` | `string` | ✅ | What this tool does (shown to LLM) |
| `parameters` | `ToolParameter[]` | ✅ | Parameter schema |
| `sideEffects` | `boolean` | ✅ | Whether tool modifies state |
| `requiresApproval` | `boolean` | ✅ | Whether user confirmation is needed |
| `timeout` | `number` | ❌ | Timeout in milliseconds |

### ToolResult Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the call succeeded |
| `data` | `unknown` | Result data |
| `summary` | `string` | Human-readable summary |
| `error` | `string` | Error message if failed |
| `durationMs` | `number` | Execution duration |
| `includeInContext` | `boolean` | Whether to include in LLM context |

### ToolContext

Available in every tool's `execute()`:

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Current session ID |
| `workspaceRoot` | `string` | Workspace directory |
| `identity` | `AgentIdentity` | Agent's identity (name, soul, rules, heartbeat, user) |
| `memory` | `MemoryAccess` | Store, recall, wiki read/write/search, scratch get/set |
| `log` | `ToolLogger` | info(), warn(), error() |

---

## Channel Interface

Create custom channels by extending the `Channel` abstract class:

```typescript
import { Channel, type ChannelConfig, type ChannelMessage } from '@lodestone/core';

interface SlackConfig extends ChannelConfig {
  type: 'slack';
  botToken: string;
  channel: string;
}

class SlackChannel extends Channel {
  private ws: WebSocket | null = null;

  constructor(config: SlackConfig) {
    super(config);
  }

  get id(): string { return `slack:${this.config.channel}`; }
  get name(): string { return 'Slack'; }

  async start(): Promise<void> {
    // Connect to Slack RTM API
    this.ws = new WebSocket('wss://slack.com/api/rtm.connect');
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'message') {
        this.emitMessage({
          sessionId: `slack-${msg.channel}`,
          content: msg.text,
          senderId: msg.user,
          senderName: msg.user,
          channelId: this.id,
          timestamp: new Date().toISOString(),
          metadata: {},
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
  }

  async send(sessionId: string, message: string): Promise<void> {
    // Send message to Slack channel
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${(this.config as SlackConfig).botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: sessionId.replace('slack-', ''), text: message }),
    });
  }
}

// Register via channel manager config
const config: LodestoneConfig = {
  // ...
  channels: {
    channels: [
      { type: 'slack', enabled: true, botToken: process.env.SLACK_TOKEN!, channel: 'general' } as ChannelConfig,
    ],
  },
};
```

### Channel Abstract Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `() => Promise<void>` | Begin listening for messages |
| `stop()` | `() => Promise<void>` | Clean up resources |
| `send()` | `(sessionId: string, message: string) => Promise<void>` | Send a message to a session |
| `get id` | `string` (getter) | Unique channel identifier |
| `get name` | `string` (getter) | Human-readable name |

### ChannelMessage

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Maps to an agent session |
| `content` | `string` | Message text |
| `senderId` | `string` | User ID on the platform |
| `senderName` | `string` | Display name |
| `channelId` | `string` | Channel instance ID |
| `timestamp` | `string` | ISO timestamp |
| `metadata` | `Record<string, unknown>` | Platform-specific extras |

---

## StreamHandler

Real-time event stream for UI updates and progressive rendering.

### Event Types

| Event | Data | Description |
|-------|------|-------------|
| `text_delta` | `{ text: string }` | Partial text content |
| `tool_call_start` | `{ toolCallId: string; toolName: string }` | Tool call begins |
| `tool_call_delta` | `{ toolCallId: string; argumentsDelta: string }` | Partial tool arguments |
| `tool_call_end` | `{ toolCallId: string; toolName: string; arguments: string }` | Tool call complete |
| `tool_result` | `{ toolCallId: string; toolName: string; success: boolean; result: string; durationMs: number }` | Tool result |
| `reasoning_delta` | `{ text: string }` | Reasoning/thinking tokens |
| `done` | `{ totalTokens: number; finishReason: string }` | Stream complete |
| `error` | `{ error: string; recoverable: boolean }` | Stream error |

### Usage

```typescript
import { StreamHandler } from '@lodestone/core';

const stream = new StreamHandler();

stream.on('text_delta', (event) => {
  process.stdout.write((event.data as { text: string }).text);
});

stream.on('tool_call_start', (event) => {
  const { toolName } = event.data as { toolName: string };
  console.log(`\n[Tool: ${toolName}]`);
});

stream.on('tool_result', (event) => {
  const { toolName, success, result, durationMs } = event.data as any;
  console.log(`  ${success ? '✓' : '✗'} ${result} (${durationMs}ms)`);
});

stream.on('done', (event) => {
  const { totalTokens, finishReason } = event.data as { totalTokens: number; finishReason: string };
  console.log(`\n[${totalTokens} tokens, ${finishReason}]`);
});

// Pass to agent loop
await loop.run(sessionId, "Search my wiki for 'architecture'", stream);

// Or access after completion
const fullText = stream.getTextContent();
const toolCalls = stream.getToolCalls();
const tokens = stream.getTotalTokens();
```

---

## SafetySystem

Deterministic guardrails. Access via `sdk.safety` or `engine.safety`.

### Capability Tiers

| Tier | Confirmation | Simulation | Sleep Mode | Examples |
|------|-------------|-----------|-----------|----------|
| `public` | ❌ | ❌ | ✅ | wiki-resolve, wiki-search, smart-retrieve, web-search, web-fetch, business-hours |
| `controlled` | ❌ | ❌ | ✅ | decision-log, resume-state, watchdog, file-ops, calendar, vision, voice |
| `restricted` | ✅ | ❌ | ❌ | code-exec, coordinator, file-write |
| `privileged` | ✅ | ✅ | ❌ | file-delete, exec, message-send, cron-add |

### SDK Safety Methods

```typescript
// Check if a tool can be auto-approved
const canAuto = agent.safety.canAutoApprove('wiki-resolve'); // true

// Check if a tool can run in sleep/heartbeat mode
const canSleep = agent.safety.canRunInSleep('decision-log'); // true

// Get behavioral rules for prompt injection
const rules = agent.safety.getRules();

// Simulate a privileged tool execution
const sim = agent.safety.simulate('file-delete', { path: '/important.txt' });
// { approved: false, riskLevel: 'high', predictedOutcome: '...' }
```

### SafetyConfig

| Field | Type | Description |
|-------|------|-------------|
| `dataDir` | `string` | Root directory for safety data |
| `customTiers` | `Record<string, Partial<TierConfig>>` | Override tool tier assignments |
| `behavioralLearning` | `Partial<BehavioralLearningConfig>` | Behavioral learning overrides |
| `memoryPromotion` | `Partial<MemoryPromotionConfig>` | Memory promotion overrides |

---

## MemorySystem

Three-layer memory. Access via `sdk.memory` or `engine.memory`.

### SDK Memory Methods

```typescript
// Vector memory
await agent.memory.store('fact_001', 'The sky is blue', { category: 'fact' });
const results = await agent.memory.recall('sky color', 5);
// [{ text: 'The sky is blue', relevance: 0.92, timestamp: '...' }]

// Wiki
const page = await agent.memory.wikiRead('architecture');
await agent.memory.wikiWrite('my-page', '# My Page\n\nContent here', {
  title: 'My Page',
  status: 'active',
});
const search = await agent.memory.wikiSearch('architecture', 5);
// [{ slug: 'architecture', title: '...', excerpt: '...', score: 0.89 }]

// Scratch buffer (session-scoped, survives compaction)
await agent.memory.scratchSet('current-task', 'Building API docs');
const task = await agent.memory.scratchGet('current-task'); // 'Building API docs'
```

### MemorySystemConfig

| Subsystem | Field | Type | Description |
|-----------|-------|------|-------------|
| Vector | `dbPath` | `string` | LanceDB directory |
| Vector | `embeddingProvider` | `'ollama' \| 'openai'` | Embedding provider |
| Vector | `embeddingModel` | `string` | Embedding model name |
| Vector | `dimensions` | `number` | Embedding dimensions (default: 768) |
| Vector | `autoRecall` | `boolean` | Auto-inject memories into context |
| Vector | `autoCapture` | `boolean` | Auto-store conversation summaries |
| Vector | `recallMaxChars` | `number` | Max chars per recall result |
| Wiki | `rootDir` | `string` | Wiki root directory |
| Wiki | `autoIndex` | `boolean` | Auto-maintain index |
| Wiki | `autoLint` | `boolean` | Validate pages on write |
| Wiki | `categories` | `string[]` | Page categories |
| Scratch | `dbPath` | `string` | Scratch database path |
| Scratch | `defaultTtlMs` | `number \| null` | Default TTL for entries |

---

## ImprovementSystem

Self-improvement subsystem. Access via `engine.improvement`.

### Subsystems

| Subsystem | Access | Description |
|-----------|--------|-------------|
| PredictionJournal | `engine.improvement.predictionJournal` | Log predictions, resolve outcomes, check calibration |
| DriftDetector | `engine.improvement.driftDetector` | Check behavior against identity rules |
| RBTDiagnosis | `engine.improvement.rbtDiagnosis` | Roses/Buds/Thorns self-assessment |
| SkillEvolver | `engine.improvement.skillEvolver` | Learn lessons, promote skills |
| SleepCycle | `engine.improvement.sleepCycle` | Nightly improvement cycle |

### Built-in Tools

Available to the agent as built-in tools:

| Tool ID | Actions |
|---------|--------|
| `wiki-resolve` | `resolve` (resolve [[wikilinks]]) |
| `wiki-search` | `search` (search wiki pages) |
| `smart-retrieve` | `retrieve` (ranked wiki + memory retrieval) |
| `decision-log` | `add`, `get`, `list`, `search`, `supersede` |
| `resume-state` | `save`, `load`, `clear` |
| `watchdog` | `watch`, `check`, `resolve`, `list` |
| `business-hours` | `check`, `config`, `should_send` |
| `web-search` | `search` (web search via configured provider) |
| `web-fetch` | `fetch` (retrieve and extract content from URL) |
| `file-ops` | `read`, `write`, `list`, `search` |
| `code-exec` | `execute` (run Python or Node.js in sandbox) |
| `calendar` | `get_schedule`, `get_next_event`, `create_event`, `find_free_slot` |
| `vision` | `analyze` (image analysis via multimodal LLM) |
| `voice` | `speak`, `transcribe` (TTS and STT) |
| `coordinator` | `spawn`, `status`, `list`, `cancel` (sub-agent management) |

### Sleep Cycle

Runs nightly at 3 AM by default. Phases: harvest → mine → reflect → consolidate → validate → prepare. Configurable via `ImprovementConfig.sleepCron`.

---

## PluginSystem

Third-party extensions with sandboxed access.

### Plugin Interface

```typescript
import type { Plugin, PluginManifest, PluginContext, PluginHookEvent, PluginHookResult } from '@lodestone/core';

const metricsPlugin: Plugin = {
  manifest: {
    id: 'metrics-export',
    name: 'Metrics Exporter',
    version: '1.0.0',
    author: 'you',
    description: 'Export tool call metrics to Prometheus',
    hooks: ['afterTool', 'onMessage'],
    configSchema: [
      {
        name: 'endpoint',
        type: 'string',
        required: true,
        default: 'http://localhost:9091',
        description: 'Prometheus pushgateway URL',
      },
    ],
  },

  async init(context: PluginContext): Promise<void> {
    this.endpoint = context.config.endpoint as string;
    context.log.info('Metrics plugin initialized');
  },

  async destroy(): Promise<void> {
    // Clean up resources
  },

  async onHook(event: PluginHookEvent): Promise<PluginHookResult | void> {
    if (event.hook === 'afterTool') {
      const { toolId, result } = event.payload as { toolId: string; result: ToolResult };
      await fetch(`${this.endpoint}/metrics/tool/${toolId}`, {
        method: 'POST',
        body: JSON.stringify({ success: result.success, durationMs: result.durationMs }),
      });
    }
    // Return void = allow
  },
};

// Register at startup
const agent = createAgent({
  // ...config
  plugins: [{ plugin: metricsPlugin, config: { endpoint: 'http://prom:9091' } }],
});

// Or at runtime
await agent.plugins.register(metricsPlugin, { endpoint: 'http://prom:9091' });
await agent.plugins.unregister('metrics-export');
```

### Hook Points

| Hook | When | Can Block | Can Modify |
|------|------|-----------|-----------|
| `onMessage` | Incoming message arrives | ❌ | ❌ |
| `beforeTool` | Before tool execution | ✅ | ✅ (params) |
| `afterTool` | After tool execution | ❌ | ✅ (result) |
| `beforeResponse` | Before response sent to user | ✅ | ✅ (content) |
| `afterResponse` | After response sent | ❌ | ❌ |

### Plugin Manifest Validation

- `id`: kebab-case, max 64 chars, unique
- `version`: semver format (e.g. `1.0.0`)
- `hooks`: at least one valid hook name
- `configSchema`: optional but validated if present

---

## Error Types

Lodestone uses a structured error hierarchy. All errors extend `LodestoneError`.

```
LodestoneError (base)
├── LodestoneConfigError   — Configuration issues (recoverable)
├── LLMError               — LLM call failures (recoverable)
├── ToolError              — Tool execution failures (recoverable)
├── ChannelError           — Channel failures (recoverable)
├── MemoryError            — Memory system failures (recoverable)
├── SafetyError            — Safety violations (NOT recoverable)
└── PluginRegistrationError — Plugin registration failures
```

### Properties

Every `LodestoneError` has:

| Property | Type | Description |
|----------|------|-------------|
| `code` | `string` | Error code (e.g. `CONFIG`, `LLM`, `TOOL`) |
| `context` | `Record<string, unknown> \| undefined` | Additional context |
| `recoverable` | `boolean` | Whether the error is recoverable |
| `toJSON()` | `object` | Serialized error for logging |

### Usage

```typescript
import { LodestoneError, isLodestoneError, errorMessage } from '@lodestone/core';

try {
  await engine.start();
} catch (err) {
  if (isLodestoneError(err)) {
    console.error(`[${err.code}] ${err.message}`);
    if (err.context) console.error('Context:', err.context);
    if (!err.recoverable) process.exit(1);
  } else {
    console.error(errorMessage(err));
  }
}
```

---

## EventEmitter Patterns

The SDK extends Node.js `EventEmitter`. Subscribe to events for monitoring, logging, and integration.

```typescript
// SDK lifecycle events
agent.on('sdk.event', (event: SDKEvent) => {
  console.log(`[${event.type}]`, event);
});

agent.on('sdk.starting', () => console.log('Starting...'));
agent.on('sdk.started', () => console.log('Started!'));
agent.on('sdk.stopping', () => console.log('Stopping...'));
agent.on('sdk.stopped', () => console.log('Stopped.'));

// Engine events
agent.on('engine.event', (event: EngineEvent) => {
  if (event.type === 'tool.called') {
    console.log(`Tool: ${event.toolId} in session ${event.sessionId}`);
  }
});

// Message events
agent.on('message.received', (req: SDKRequest) => {
  console.log(`[${req.senderName}] ${req.content}`);
});

agent.on('message.sent', (res: SDKResponse) => {
  console.log(`Response: ${res.content} (${res.durationMs}ms)`);
});

// Plugin custom events
agent.on('plugin.custom', (event: PluginCustomEvent) => {
  console.log(`[${event.pluginId}] ${event.name}`, event.data);
});
```

### Complete Event Reference

| Event | Payload | When |
|-------|---------|------|
| `sdk.starting` | `{ type, timestamp }` | SDK beginning startup |
| `sdk.started` | `{ type, timestamp }` | SDK fully started |
| `sdk.stopping` | `{ type, timestamp }` | SDK beginning shutdown |
| `sdk.stopped` | `{ type, timestamp }` | SDK fully stopped |
| `engine.event` | `EngineEvent` | Any engine event |
| `message.received` | `SDKRequest` | Incoming message |
| `message.sent` | `SDKResponse` | Outgoing response |
| `plugin.custom` | `PluginCustomEvent` | Plugin-emitted event |
| `sdk.event` | `SDKEvent` | Union of all events |

---

## Related

- **[Getting Started →](getting-started.md)** — 5-minute quickstart
- **[Architecture →](architecture.md)** — System design and data flow
# Lodestone Architecture

> How the pieces fit together. This document explains the system design, component responsibilities, and data flow.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Lodestone Engine                               │
│                                                                         │
│  ┌──────────┐   ┌──────────────────────────────────────────────────┐   │
│  │ Identity │   │                  Agent Loop                        │   │
│  │ (SOUL)   │──▶│  LLM ──▶ Tool Calls ──▶ Results ──▶ LLM ──▶ Out  │   │
│  └──────────┘   └──────────────────────────────────────────────────┘   │
│         │                    │           │            │           │     │
│         ▼                    ▼           ▼            ▼           ▼     │
│  ┌──────────┐   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Safety   │   │ Tools    │ │ Memory   │ │Improvement│ │Streaming │   │
│  │ System   │   │ Registry │ │ System   │ │ System   │ │ Handler  │   │
│  │          │   │          │ │          │ │          │ │          │   │
│  │• Cap     │   │• Built-in│ │• Vector  │ │• Predict │ │• Delta   │   │
│  │  Tiers   │   │• Custom  │ │  DB      │ │  Journal │ │• Tool    │   │
│  │• Behav.  │   │• Registry│ │• Wiki    │ │• Drift   │ │  events  │   │
│  │  Learn   │   │          │ │• Scratch │ │• RBT     │ │• Done    │   │
│  │• Memory  │   │          │ │          │ │• Skills  │ │          │   │
│  │  Promo   │   │          │ │          │ │• Sleep   │ │          │   │
│  │• Truth   │   │          │ │          │ │  Cycle   │ │          │   │
│  │  Bind    │   │          │ │          │ │• Calib.  │ │          │   │
│  │• Intent  │   │          │ │          │ │• Patches │ │          │   │
│  │  Predict │   │          │ │          │ │• Multi-  │ │          │   │
│  │• Quality │   │          │ │          │ │  Agent   │ │          │   │
│  │  Gates   │   │          │ │          │ │• Proact. │ │          │   │
│  │• Undo    │   │          │ │          │ │• Self-   │ │          │   │
│  │  System  │   │          │ │          │ │  Patch   │ │          │   │
│  └──────────┘   └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│         │                    │                                   │     │
│         ▼                    ▼                                   ▼     │
│  ┌──────────┐   ┌──────────┐ ┌──────────┐               ┌──────────┐  │
│  │Scheduler │   │Channel   │ │ Cost     │               │ Plugin   │  │
│  │          │   │ Manager  │ │ Tracker  │               │ System   │  │
│  │• Cron    │   │          │ │          │               │          │  │
│  │• Interval│   │• Telegram│ │• Tokens  │               │• Hooks   │  │
│  │• One-shot│   │• Discord │ │• Budget  │               │• Sandbox │  │
│  │          │   │• WebChat │ │• Reports │               │• Config  │  │
│  │          │   │• Email   │ │          │               │          │  │
│  │          │   │• Voice   │ │          │               │          │  │
│  └──────────┘   └──────────┘ └──────────┘               └──────────┘  │
│         │              │          │                          │        │
│         ▼              ▼          ▼                          ▼        │
│  ┌──────────┐   ┌──────────┐ ┌──────────┐           ┌──────────────┐ │
│  │ Model    │   │ Sessions │ │ Model    │           │ Migration    │  │
│  │ Router   │   │ Manager  │ │ A/B Test │           │ System       │  │
│  └──────────┘   └──────────┘ └──────────┘           └──────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### Engine (Orchestrator)

The `LodestoneEngine` is the top-level coordinator. It wires together all subsystems, manages lifecycle (start/stop), and emits events. Everything flows through it — tool registration, session creation, channel routing, and scheduled jobs.

### AgentLoop

The heart of the engine. One "turn" of the agent loop:

1. **Receive** a user message and add it to the session
2. **Construct system prompt** from identity (SOUL.md, RULES.md) + auto-recalled memories + behavioral rules
3. **Call the LLM** (streaming or non-streaming)
4. **Parse tool calls** from the LLM response
5. **Execute tools** through the ToolRegistry (with safety checks)
6. **Feed results** back into the LLM context
7. **Repeat** until no more tool calls or max rounds reached
8. **Stream final response** to the user
9. **Auto-capture** conversation summary to memory (if enabled)
10. **Compact context** if session exceeds threshold

```typescript
const loop = new AgentLoop(engine, {
  maxToolRounds: 10,
  maxTokens: 8192,
  temperature: 0.7,
  stream: true,
  autoRecall: true,
  autoCapture: false,
});
const result = await loop.run(sessionId, "What's in my wiki?", streamHandler);
```

### MemorySystem

Three layers, unified under one interface:

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Vector DB** | LanceDB | Semantic recall — find relevant past conversations by meaning, not keywords |
| **Wiki** | Markdown files | Curated, cross-linked knowledge base with frontmatter and `[[wikilinks]]` |
| **Scratch Buffer** | JSON/SQLite | Session-scoped key-value store for temporary state (survives context compaction) |

The `smartRetrieve()` method searches wiki + vector in parallel and returns ranked results. This is what gets injected into the system prompt before each LLM call.

### SafetySystem

Deterministic guardrails. **No LLM in the policy path** — every safety decision is code, not a model call.

| Subsystem | What It Does |
|-----------|-------------|
| **Capability Tiers** | Every tool is classified: `public` → `controlled` → `restricted` → `privileged`. Higher tiers require confirmation and simulation. |
| **Behavioral Learning** | When the user corrects the agent ("No, don't do X"), a rule is extracted and stored. Rules are injected into future system prompts. |
| **Memory Promotion** | Claims must pass verification levels before being promoted to wiki. Evidence-gated — no unverified claims in the knowledge base. |
| **Truth Binding** | Prevents the agent from asserting unverified claims as facts. |
| **Intent Prediction** | Predicts likely outcomes before executing privileged tools. |
| **Quality Gates** | Validates tool outputs before they enter the context. |
| **Undo System** | Records reversible actions so the agent can undo mistakes. |

### ImprovementSystem

The self-improvement loop. This is what makes Lodestone get better over time:

```
Predict ──▶ Act ──▶ Resolve ──▶ Calibrate ──▶ Detect Drift ──▶ Patch
   │                                                        │
   └──────────────────────── Sleep Cycle ───────────────────┘
                    (nightly at 3 AM)
```

| Subsystem | Purpose |
|-----------|---------|
| **Prediction Journal** | Log predictions before acting. Resolve with actual outcomes. Track Brier score and calibration. |
| **RBT Diagnosis** | Roses (wins), Buds (potential), Thorns (problems). Structured self-assessment. |
| **Sleep Cycle** | Nightly batch: harvest data → mine patterns → reflect → consolidate → validate → prepare. Runs at 3 AM by default. |
| **Drift Detection** | Compare recent decisions against identity rules. Flag deviations. |
| **Calibration Loop** | Measure prediction accuracy over time. Adjust confidence. |
| **Patch Automation** | Generate and apply self-improvement patches. |
| **Multi-Agent** | Coordinate multiple agents on improvement tasks. |
| **Proactive Intelligence** | Decide what to work on without being asked. |
| **Self-Patching** | Apply learned improvements to the agent's own configuration. |
| **Skill Evolution** | Learn lessons from experience → validate → promote to core instructions. |

### ChannelManager

Connects Lodestone to external messaging platforms. Each channel implements the `Channel` interface:

| Channel | Status | Streaming |
|---------|--------|-----------|
| **WebChat** | Built-in (Express + Socket.IO) | ✅ |
| **Telegram** | Built-in (Grammy) | ✅ |
| **Discord** | Built-in (discord.js) | ✅ |
| **Email** | Built-in (IMAP/SMTP) | ❌ |
| **Voice** | Built-in | ❌ |

Session routing: each (channel, user) pair maps to one agent session. The ChannelManager routes incoming messages to the agent loop and responses back to the originating channel.

### ToolRegistry

Tools are the agent's hands. The registry manages registration, lookup, and execution:

```typescript
engine.registerTool({
  definition: {
    id: 'my-tool',
    name: 'My Tool',
    description: 'Does something useful',
    parameters: [{ name: 'input', type: 'string', required: true, description: 'Input text' }],
    sideEffects: false,
    requiresApproval: false,
  },
  async execute(params, context) {
    return { success: true, data: params.input, summary: 'Done', durationMs: 0, includeInContext: true };
  },
});
```

Built-in tools: `wiki-resolve`, `smart-retrieve`, `decision-log`, `resume-state`, `watchdog`, `business-hours`, `prediction-journal`, `drift-check`, `rbt-diagnose`, `skill-learn`.

### Scheduler

Proactive scheduling. Jobs run on cron expressions, intervals, or one-shot timers:

```typescript
engine.registerJob({
  id: 'morning-brief',
  name: 'Morning Briefing',
  description: 'Summarize overnight activity and pending tasks',
  schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Toronto' },
  enabled: true,
  timeoutSeconds: 300,
});
```

The sleep cycle, sensorium, and drift detection are all scheduled jobs registered at startup.

### StreamHandler

Real-time event stream for UI updates. Emits typed events as the LLM generates output:

| Event | When |
|-------|------|
| `text_delta` | Partial text content arrives |
| `tool_call_start` | LLM requests a tool call |
| `tool_result` | Tool execution completes |
| `reasoning_delta` | Reasoning/thinking tokens (if supported) |
| `done` | Stream complete with token count |
| `error` | Stream error |

### CostTracker

Tracks token usage and costs across all LLM calls. Configurable pricing per model. Emits budget alerts when spending exceeds thresholds.

### ModelRouter

Routes LLM calls to different models based on task complexity. Route "fast" tasks to a small model, "smart" tasks to a large model. Rules are configurable.

### ABTesting

A/B test prompt variants. Run two prompt formulations against the same inputs and measure which produces better outcomes.

### PluginSystem

Third-party extensions hook into the agent lifecycle without touching core internals:

- **Hooks**: `beforeTool`, `afterTool`, `beforeResponse`, `afterResponse`, `onMessage`
- **Sandboxed**: Plugins get a limited context — no access to engine internals
- **No LLM calls**: Plugins are pure code. All model interaction stays in the core loop.

### MigrationSystem

Schema migrations for the data layer. Runs automatically on startup. Versioned and reversible.

### UserManager

Multi-user support. Each user gets their own sessions and identity context. Token-based authentication.

## Data Flow

```
User sends message
    │
    ▼
Channel (Telegram/Discord/WebChat)
    │
    ▼
ChannelManager.handleIncomingMessage()
    │  Creates or reuses session for (channel, user)
    ▼
AgentLoop.run(sessionId, message)
    │
    ├──▶ Build system prompt
    │    ├── Identity (SOUL.md + RULES.md)
    │    ├── Auto-recalled memories (Vector DB + Wiki)
    │    └── Behavioral rules (SafetySystem)
    │
    ├──▶ Call LLM (streaming)
    │    │
    │    ├── StreamHandler emits text_delta events
    │    │   └── Channel streams to user in real-time
    │    │
    │    └── LLM returns text + tool calls
    │
    ├──▶ Execute tool calls (for each)
    │    ├── SafetySystem.canAutoApprove(toolId)
    │    ├── PluginSystem.beforeTool hook
    │    ├── ToolRegistry.execute(toolId, params, context)
    │    ├── PluginSystem.afterTool hook
    │    └── StreamHandler emits tool_result
    │
    ├──▶ Feed tool results back to LLM
    │    └── Loop back to "Call LLM" (max 10 rounds)
    │
    ├──▶ Final response
    │    ├── Auto-capture to memory (if enabled)
    │    ├── Check context compaction threshold
    │    └── StreamHandler emits done
    │
    ▼
Channel.send(sessionId, response)
    │
    ▼
User receives response
```

## Key Design Decisions

### 1. No LLM in the Policy Path

All safety decisions are deterministic code. The LLM never decides whether something is safe — the SafetySystem does, using capability tiers, behavioral rules, and simulation. This prevents prompt injection from disabling guardrails.

### 2. Evidence-Gated Memory Promotion

Claims don't enter the wiki just because the agent said them. They go through a promotion pipeline: submit → verify → promote. The `MemoryPromotion` system tracks verification levels and conflicts. Only claims that pass verification become permanent wiki entries.

### 3. Self-Improvement Loop

The agent doesn't just learn from user feedback — it actively predicts outcomes, measures its accuracy, and patches itself. The sleep cycle runs nightly to harvest, mine, reflect, consolidate, validate, and prepare. Over time, the agent gets calibrated and drifts less.

### 4. Identity-Driven

The agent's behavior is shaped by identity files (SOUL.md, RULES.md, USER.md, HEARTBEAT.md). These are user-provided and fully editable. The agent doesn't have a hardcoded personality — it has the personality you give it. The drift detector checks that recent behavior aligns with the stated identity.

## Next Steps

- **[Getting Started →](getting-started.md)** — Get a running agent in 5 minutes
- **[API Reference →](api-reference.md)** — Embed Lodestone in your application
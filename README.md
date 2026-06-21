# Lodestone 🔮

> Take any LLM from "answers questions" to "thinks ahead, remembers everything, gets better over time, and runs itself."

Lodestone is a standalone agent engine that gives LLMs persistent memory, self-improvement loops, proactive scheduling, and a curated knowledge system — all deployable in one command.

**Quick start:**

```bash
npx lodestone init --template developer
cd my-agent
lodestone start
```

---

## What It Does

Most LLM wrappers give you a chatbot. Lodestone gives you an agent that:

- **Remembers everything** — Three-layer memory (vector recall, curated wiki, session scratch) means knowledge compounds across sessions. Ask something on Tuesday, get the answer instantly on Thursday.
- **Improves itself** — Prediction journals, pre-mortems, drift detection, calibration loops, and skill synthesis. The agent gets better at its job over time, not just longer context windows.
- **Works proactively** — Health checks, consolidation cycles, morning briefs, and dream mode. The agent thinks even when you're not talking to it.
- **Has identity** — You define WHO it is (SOUL.md), WHAT it knows (wiki), HOW it operates (RULES.md), and WHAT it focuses on (HEARTBEAT.md). Not a blank slate — a shaped tool.
- **Stays safe** — Behavioral learning, quality gates, self-constraints, intent prediction, and explainability traces. The agent learns from mistakes and enforces its own guardrails.
- **Compounds knowledge** — Start empty or from templates. The wiki grows, cross-links, and gets linted automatically. Yesterday's research is tomorrow's context.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     IDENTITY LAYER                        │
│   SOUL.md  ·  IDENTITY.md  ·  USER.md  ·  RULES.md     │
│                  HEARTBEAT.md                             │
├──────────────────────────────────────────────────────────┤
│                     ENGINE CORE                           │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Memory       │  │ Self-         │  │ Proactive     │   │
│  │ ┌ Wiki       │  │ Improvement   │  │ ┌ Sensorium   │   │
│  │ ├ Vector DB  │  │ ┌ Predictions │  │ ├ Sleep Cycle │   │
│  │ └ Scratch    │  │ ├ Calibration │  │ ├ Briefs     │   │
│  │              │  │ ├ Drift Det.  │  │ └ Watchdog   │   │
│  │              │  │ ├ A/B Testing │  │              │   │
│  │              │  │ └ Dream Mode  │  │              │   │
│  ├─────────────┤  ├──────────────┤  ├──────────────┤   │
│  │ Safety       │  │ Session Mgmt │  │ Scheduler     │   │
│  │ ┌ Quality    │  │ ┌ Create     │  │ ┌ Cron jobs  │   │
│  │   Gates      │  │ ├ Compact    │  │ ├ Intervals  │   │
│  │ ├ Self-      │  │ ├ Persist    │  │ └ Queues     │   │
│  │   Constraints│  │ └ Resume     │  │              │   │
│  │ ├ Explain.   │  │              │  │              │   │
│  │ ├ Confidence │  │              │  │              │   │
│  │ ├ Failure    │  │              │  │              │   │
│  │ │ Replay     │  │              │  │              │   │
│  │ └ Intent     │  │              │  │              │   │
│  │   Prediction │  │              │  │              │   │
│  ├─────────────┤  ├──────────────┤  ├──────────────┤   │
│  │ Tools (15)   │  │ Channels     │  │ Plugins       │   │
│  │ ┌ wiki-resolve│ │ ┌ Telegram   │  │ ┌ Hooks (5)   │   │
│  │ ├ wiki-search │  │ ├ Discord   │  │ ├ onMessage   │   │
│  │ ├ smart-retr. │  │ ├ Email     │  │ ├ beforeTool  │   │
│  │ ├ decision-log│  │ ├ Dashboard │  │ ├ afterTool   │   │
│  │ ├ resume-state│  │ └ CLI/TUI   │  │ ├ beforeResp  │   │
│  │ ├ watchdog    │  │              │  │ └ afterResp   │   │
│  │ ├ biz-hours   │  │              │  │              │   │
│  │ ├ web-search  │  │              │  │              │   │
│  │ ├ web-fetch   │  │              │  │              │   │
│  │ ├ file-ops    │  │              │  │              │   │
│  │ ├ code-exec   │  │              │  │              │   │
│  │ ├ calendar    │  │              │  │              │   │
│  │ ├ vision      │  │              │  │              │   │
│  │ ├ voice       │  │              │  │              │   │
│  │ └ coordinator │  │              │  │              │   │
│  └─────────────┘  └──────────────┘  └──────────────┘   │
├──────────────────────────────────────────────────────────┤
│                     LLM RUNTIME                           │
│  Multi-provider · Streaming · Tool execution · Routing   │
│  (Ollama · OpenAI · Anthropic · any OpenAI-compatible)   │
├──────────────────────────────────────────────────────────┤
│                     CHANNELS                              │
│      CLI · TUI Chat · Telegram · Discord · Email · API    │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Initialize

```bash
# Create a new agent workspace
npx lodestone init

# Or pick a template
npx lodestone init --template developer   # Coding agent
npx lodestone init --template business    # Sales/CRM agent
npx lodestone init --template creative    # Writer/content agent
npx lodestone init --template researcher  # Research agent
npx lodestone init --template general     # General-purpose agent
```

The wizard creates:
- `my-agent/workspace/` — Identity files, wiki scaffold, data directories
- `my-agent/lodestone.config.yaml` — Full configuration
- `my-agent/.env` — Environment variables (API keys, model selection)

### 2. Configure

Edit `my-agent/workspace/SOUL.md` to define your agent's personality. Edit `lodestone.config.yaml` to set your LLM provider:

```yaml
llm:
  default:
    type: ollama                    # or openai, anthropic
    model: glm-5.2:cloud
    baseUrl: http://127.0.0.1:11434/api
```

### 3. Run

```bash
cd my-agent
lodestone start      # Boot the engine
lodestone chat       # Interactive TUI chat
lodestone status     # Check engine status
lodestone doctor     # Run 25 health checks
```

Or with Docker:

```bash
docker compose up
```

## Example Agents

Lodestone ships with three ready-to-use example agents in `examples/`:

| Agent | Emoji | Best For | Description |
|-------|-------|----------|-------------|
| [business-ops](examples/business-ops/) | ⚙️ | Operations | Monitors systems, triages alerts, manages workflows |
| [researcher](examples/researcher/) | 🔍 | Research | Literature review, evidence synthesis, citation tracking |
| [customer-support](examples/customer-support/) | 💬 | Support | Ticket routing, response drafting, escalation handling |

Each example includes a README, identity files (SOUL.md, IDENTITY.md), and a sample config.

## Configuration Reference

`lodestone.config.yaml` — all options with defaults:

```yaml
# LLM Provider
llm:
  default:
    type: ollama                    # ollama | openai | anthropic
    model: glm-5.2:cloud            # Model identifier
    baseUrl: http://127.0.0.1:11434/api
    contextWindow: 128000           # Context window (tokens)
    maxTokens: 8192                # Max output (tokens)
  routes:                           # Route tasks to different models
    fast:
      type: ollama
      model: glm-5.2:cloud
    smart:
      type: openai
      model: gpt-4o
      apiKey: ${OPENAI_API_KEY}

# Memory system
memory:
  vectorDb:
    provider: lancedb               # lancedb (local, no server)
    path: ./workspace/data/lancedb
    embedding:
      provider: ollama              # ollama | openai
      model: nomic-embed-text
      dimensions: 768
    autoRecall: true                 # Auto-inject relevant memories
    autoCapture: false              # Auto-store all turns
  wiki:
    path: ./workspace/memory/wiki
    autoLint: true                  # Nightly wiki lint
    autoIndex: true                 # Auto-generate index.md
  scratch:
    path: ./workspace/data/scratch.db

# Identity (where SOUL.md, IDENTITY.md, etc. live)
identity:
  dir: ./workspace

# Session management
session:
  compactionThreshold: 0.5          # Compact at 50% capacity
  keepRecentCount: 10
  maxEntries: 200
  pruneAfter: 7d
  persist: false                    # Set true for SQLite persistence
                                    # (requires better-sqlite3)

# Proactive systems
proactive:
  sensorium:
    enabled: true
    interval: 30m
  sleep:
    enabled: true
    schedule: "0 3 * * *"           # 3am daily (dream mode)
    timezone: "America/Toronto"
  drift:
    enabled: true
    schedule: "0 9 * * 1"           # Weekly Monday 9am
  calibration:
    enabled: true
    interval: 1h                    # Hourly Brier score calibration
  abTesting:
    enabled: true                   # Variant injection + outcome recording

# Safety systems
safety:
  qualityGates: true                # Block low-quality outputs
  selfConstraints: true             # Self-imposed behavioral limits
  explainability: true              # Decision trace recording
  confidenceDisplay: true           # Calibrated confidence scoring
  failureReplay: true               # Learn from past failures
  intentPrediction: true            # Predict user intent before acting

# Scheduler
scheduler:
  maxConcurrent: 4

# Logging
logging:
  level: info                        # debug | info | warn | error
  file: ./workspace/data/logs/lodestone.log

# Plugins
plugins:
  enabled: true
  hooks:
    - onMessage
    - beforeTool
    - afterTool
    - beforeResponse
    - afterResponse
```

## CLI Commands

```
lodestone init                Interactive workspace wizard
lodestone start               Boot the engine
lodestone status              Show engine status
lodestone chat                Start TUI chat interface
lodestone tools list          List registered tools (39 built-in)
lodestone memory stats        Show memory statistics
lodestone config show          Display current configuration
lodestone config set <k> <v>  Update a config value
lodestone doctor              Run 25 health checks
```

## Built-in Tools (39)

| Tool | Purpose |
|------|---------|
| `wiki-resolve` | Resolve [[wikilinks]] to file paths and content |
| `wiki-search` | Search wiki pages by title, slug, or tag |
| `wiki-write` | Write and update wiki pages with frontmatter |
| `wiki-read` | Read wiki page content by slug |
| `memory-store` | Store facts in long-term vector memory |
| `memory-recall` | Recall memories by semantic similarity |
| `smart-retrieve` | Get wiki pages ranked by relevance to current task |
| `decision-log` | Record and query decisions with rationale |
| `resume-state` | Save/load task state across sessions |
| `watchdog` | Register expected outcomes with deadlines |
| `business-hours` | Check if it's business hours before sending |
| `web-search` | Search the web for current information |
| `web-fetch` | Fetch and extract readable content from a URL |
| `file-ops` | Read, write, and manage files |
| `code-exec` | Execute shell commands safely |
| `shell` | Execute shell commands with sandboxing |
| `http` | Make HTTP requests with timeout support |
| `process-manager` | Spawn and manage background processes |
| `diff-patch` | Apply find-and-replace patches to files |
| `git` | Run git commands (status, diff, commit, etc.) |
| `browser` | Browser automation via Playwright |
| `scheduler` | Schedule and manage recurring tasks |
| `send-message` | Send messages via email, Slack, Discord, Telegram |
| `database` | Query SQLite/PostgreSQL databases |
| `mcp-client` | Connect to MCP (Model Context Protocol) servers |
| `image-gen` | Generate images via DALL-E or local models |
| `ocr` | Extract text from images via Tesseract |
| `transcribe` | Transcribe audio/video via Whisper |
| `clipboard` | Read and write system clipboard |
| `notify` | Send desktop notifications |
| `secrets` | Store and retrieve encrypted secrets |
| `search-engine` | Web search via SearXNG or Google CSE |
| `screenshot` | Capture screenshots |
| `archive` | Create and extract zip archives |
| `lsp` | Language Server Protocol bridge for code intelligence |
| `calendar` | Schedule and manage events |
| `vision` | Analyze images and visual content |
| `voice` | Text-to-speech output |
| `coordinator` | Spawn and manage sub-agents |

## Templates

| Template | Best For | Emoji | Focus |
|----------|----------|-------|-------|
| `developer` | Software engineering | ⌨️ | Code, PRs, debugging, git |
| `business` | Sales, CRM, operations | 📊 | Pipelines, follow-ups, revenue |
| `creative` | Writing, content, marketing | ✨ | Blog posts, copy, brainstorming |
| `researcher` | Literature review, analysis | 🔬 | Citations, data, evidence |
| `general` | All-purpose assistant | ⚡ | Adaptable to any domain |

Each template includes: IDENTITY.md, SOUL.md, USER.md, RULES.md, HEARTBEAT.md, lodestone.config.yaml

## Channel Setup

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Set `TELEGRAM_BOT_TOKEN` in `.env`
3. Configure the Telegram channel in your config

### Discord

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers)
2. Set `DISCORD_BOT_TOKEN` in `.env`
3. Configure the Discord channel in your config

### Email

1. Set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` in `.env`
2. Configure the email channel in your config
3. Requires `nodemailer` and `imap` (optional peer deps)

### Web Chat

The built-in TUI chat (`lodestone chat`) works out of the box. For a web interface, use the dashboard API server.

## Self-Improvement Features

| Feature | What It Does | Schedule |
|---------|-------------|----------|
| **Prediction Journal** | Records predictions, checks outcomes, computes Brier scores | Each response |
| **Calibration Loop** | Adjusts confidence based on historical accuracy | Hourly |
| **Drift Correction** | Detects behavioral drift and injects corrective prompts | Every 6 hours |
| **Dream Mode** | Consolidates learnings, synthesizes skills, patches behavior | Nightly 3am |
| **A/B Testing** | Tests prompt variants and records outcomes | Per-response |
| **Failure Replay** | Analyzes failures and generates prevention rules | On failure |
| **Skill Synthesizer** | Creates new skills from accumulated tool sequences | During dream cycle |
| **Sleep Cycle** | Runs self-improvement cycle with pre-mortems and reflection | Nightly 3am |

## Safety Features

| Feature | What It Does |
|---------|-------------|
| **Quality Gates** | Reviews outputs by type (code, advice, sensitive) and blocks low-quality responses |
| **Self-Constraints** | Self-imposed behavioral limits approved by the agent itself |
| **Explainability** | Records decision traces showing why each action was taken |
| **Confidence Display** | Calibrated confidence scores with band labels (high/moderate/low/very-low) |
| **Failure Replay** | Replays past failures to generate prevention rules |
| **Intent Prediction** | Predicts user intent before executing tools |
| **Behavioral Learning** | Learns from corrections and adjusts future behavior |
| **Contextual Style** | Adapts tone, formality, and verbosity to context |

## Development Guide

### Prerequisites

- Node.js 22+
- Ollama (for local LLM) or API keys for OpenAI/Anthropic

### Setup

```bash
git clone https://github.com/greyrockstudios/lodestone.git
cd lodestone
npm install
npm run build
```

### Project Structure

```
lodestone/
├── packages/
│   ├── core/                  # Engine runtime (44,000+ lines)
│   │   └── src/
│   │       ├── engine.ts       # Main orchestrator
│   │       ├── agent-loop.ts   # LLM → tool → response cycle
│   │       ├── sdk.ts          # Public API for embedding
│   │       ├── llm/            # Multi-provider LLM abstraction
│   │       ├── memory/         # Wiki + Vector + Scratch
│   │       ├── tools/          # Built-in tools (15)
│   │       ├── session/        # Session management & persistence
│   │       ├── scheduler/      # Cron & interval job system
│   │       ├── streaming/      # Response streaming handler
│   │       ├── channels/       # Channel adapters (Telegram, Discord, Email, Dashboard)
│   │       ├── safety/         # Quality gates, self-constraints, explainability, confidence
│   │       ├── improvement/    # Calibration, drift, dream mode, A/B testing, skill synthesis
│   │       ├── identity/       # SOUL/IDENTITY/RULES loader, contextual style
│   │       ├── plugin-system/  # Plugin hooks (5 lifecycle events)
│   │       ├── dashboard/      # Web dashboard with auth
│   │       └── utils/          # Logger, config validator, health checker
│   └── cli/                    # CLI tool
│       └── src/
│           ├── index.ts         # Commander.js entry point
│           └── commands/        # init, start, status, chat, tools, memory, config, doctor
├── examples/                   # Example agents (3)
│   ├── business-ops/
│   ├── researcher/
│   └── customer-support/
├── templates/                  # Identity templates (5)
│   ├── developer/
│   ├── business/
│   ├── creative/
│   ├── researcher/
│   └── general/
├── docs/                       # Documentation
│   ├── getting-started.md
│   ├── architecture.md
│   └── api-reference.md
├── docker/                     # Docker configuration
├── scripts/                    # Proactive scripts
├── CONTRIBUTING.md             # Contribution guide
└── docker-compose.yml          # One-command deployment
```

### Build & Test

```bash
npm run build          # Build all packages
npm test               # Run 243 tests
npm run test:dogfood   # Run 21 integration tests
npm run dev            # Watch mode
```

### Adding a Tool

1. Create `packages/core/src/tools/impl/my-tool.ts`
2. Implement the `Tool` interface (definition + execute)
3. Register in `main.ts`
4. Export from `packages/core/src/index.ts`

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

### Adding a Channel

1. Create `packages/core/src/channels/my-channel.ts`
2. Extend the `Channel` base class (retry, rate-limiting, and splitting are built-in)
3. Implement `sendRaw()` and `getMaxMessageLength()`
4. Wire into the engine startup

### Adding a Plugin

1. Create a plugin implementing one or more hooks:
   - `onMessage` — fired when a message arrives
   - `beforeTool` — fired before tool execution (can block or modify)
   - `afterTool` — fired after tool execution
   - `beforeResponse` — fired before sending response (can modify)
   - `afterResponse` — fired after response is sent
2. Register via `engine.plugins.register(plugin)`

## SDK Usage

Embed Lodestone in your own application:

```typescript
import { createAgent } from '@lodestone/core';

const agent = await createAgent({
  workspaceRoot: './my-agent',
  llm: { type: 'ollama', model: 'glm-5.2:cloud' },
});

// Process a message
const response = await agent.processMessage('user-1', 'What did we discuss yesterday?');

// Access subsystems
agent.engine.memory.vector.store('key', 'value');
agent.engine.safety.explainability.getTrace('session-1');
```

## Stats

- **43,660 lines** of TypeScript
- **243 tests** + 21 dogfood tests — all passing
- **39 built-in tools**
- **5 channels** (CLI, TUI, Telegram, Discord, Email)
- **8 self-improvement systems**
- **8 safety systems**
- **5 plugin hooks**
- **3 example agents**
- **5 identity templates**

## License

MIT

---

Built with 🔮 by [Greyrock Studio](https://greyrockstudios.dev)
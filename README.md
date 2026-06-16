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
- **Improves itself** — Prediction journals, pre-mortems, drift detection, and skill evolution. The agent gets better at its job over time, not just longer context windows.
- **Works proactively** — Health checks, consolidation cycles, and morning briefs. The agent thinks even when you're not talking to it.
- **Has identity** — You define WHO it is (SOUL.md), WHAT it knows (wiki), HOW it operates (RULES.md), and WHAT it focuses on (HEARTBEAT.md). Not a blank slate — a shaped tool.
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
│  │ └ Scratch    │  │ ├ Drift Det.  │  │ ├ Briefs     │   │
│  │              │  │ └ Skills      │  │ └ Watchdog   │   │
│  ├─────────────┤  ├──────────────┤  ├──────────────┤   │
│  │ Tools        │  │ Session Mgmt │  │ Scheduler     │   │
│  │ ┌ wiki-resolve│  │ ┌ Create     │  │ ┌ Cron jobs  │   │
│  │ ├ smart-retr. │  │ ├ Compact    │  │ ├ Intervals  │   │
│  │ ├ decision-log│  │ └ Resume     │  │ └ Queues     │   │
│  │ ├ watchdog    │  │              │  │              │   │
│  │ ├ resume-state│  │              │  │              │   │
│  │ └ biz-hours   │  │              │  │              │   │
│  └─────────────┘  └──────────────┘  └──────────────┘   │
├──────────────────────────────────────────────────────────┤
│                     LLM RUNTIME                           │
│  Multi-provider · Streaming · Tool execution · Routing   │
│  (Ollama · OpenAI · Anthropic · any OpenAI-compatible)   │
├──────────────────────────────────────────────────────────┤
│                     CHANNELS                              │
│         CLI · TUI Chat · Telegram · Discord · API         │
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
    model: glm-5.1:cloud
    baseUrl: http://127.0.0.1:11434/api
```

### 3. Run

```bash
cd my-agent
lodestone start      # Boot the engine
lodestone chat       # Interactive TUI chat
lodestone status     # Check engine status
```

Or with Docker:

```bash
docker compose up
```

## Configuration Reference

`lodestone.config.yaml` — all options with defaults:

```yaml
# LLM Provider
llm:
  default:
    type: ollama                    # ollama | openai | anthropic
    model: glm-5.1:cloud            # Model identifier
    baseUrl: http://127.0.0.1:11434/api
    contextWindow: 128000           # Context window (tokens)
    maxTokens: 8192                # Max output (tokens)
  routes:                           # Route tasks to different models
    fast:
      type: ollama
      model: glm-5.1:cloud
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

# Proactive systems
proactive:
  sensorium:
    enabled: true
    interval: 30m
  sleep:
    enabled: true
    schedule: "0 3 * * *"           # 3am daily
    timezone: "America/Toronto"
  drift:
    enabled: true
    schedule: "0 9 * * 1"           # Weekly Monday 9am

# Scheduler
scheduler:
  maxConcurrent: 4

# Logging
logging:
  level: info                        # debug | info | warn | error
  file: ./workspace/data/logs/lodestone.log
```

## CLI Commands

```
lodestone init                Interactive workspace wizard
lodestone start               Boot the engine
lodestone status              Show engine status
lodestone chat                Start TUI chat interface
lodestone tools list          List registered tools
lodestone memory stats        Show memory statistics
lodestone config show          Display current configuration
lodestone config set <k> <v>  Update a config value
```

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

### Web Chat

The built-in TUI chat (`lodestone chat`) works out of the box. For a web interface, see the API server configuration.

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
│   ├── core/                  # Engine runtime
│   │   └── src/
│   │       ├── engine.ts       # Main orchestrator
│   │       ├── agent-loop.ts   # LLM → tool → response cycle
│   │       ├── llm/            # Multi-provider LLM abstraction
│   │       ├── memory/         # Wiki + Vector + Scratch
│   │       ├── tools/          # Built-in tools (7)
│   │       ├── session/        # Session management & compaction
│   │       ├── scheduler/      # Cron & interval job system
│   │       ├── streaming/      # Response streaming handler
│   │       ├── channels/       # Channel adapters
│   │       └── identity/       # SOUL/IDENTITY/RULES loader
│   └── cli/                    # CLI tool
│       └── src/
│           ├── index.ts         # Commander.js entry point
│           └── commands/        # init, start, status, chat, etc.
├── templates/                  # Identity templates (5)
│   ├── developer/
│   ├── business/
│   ├── creative/
│   ├── researcher/
│   └── general/
├── docker/                     # Docker configuration
├── scripts/                    # Proactive scripts
└── docker-compose.yml          # One-command deployment
```

### Build & Test

```bash
npm run build          # Build all packages
npm run test           # Run tests
npm run dev            # Watch mode
npm run lint           # Lint
```

### Adding a Tool

1. Create `packages/core/src/tools/impl/my-tool.ts`
2. Implement the `Tool` interface (definition + execute)
3. Register in `main.ts` or via the CLI
4. Add to the tool count in status output

### Adding a Channel

1. Create `packages/core/src/channels/my-channel.ts`
2. Implement the `Channel` interface
3. Add authentication config
4. Wire into the engine startup

## Milestones

### M1: First Breath ✅
Docker Compose boots an agent that starts thinking proactively within 5 minutes.

- ✅ Runtime core (LLM abstraction, tool execution, streaming)
- ✅ Session management (create, resume, compaction)
- ✅ Memory system (wiki, vector DB, scratch buffer)
- ✅ Built-in tools (7: wiki-resolve, wiki-search, smart-retrieve, decision-log, resume-state, watchdog, business-hours)
- ✅ Identity loader (SOUL, IDENTITY, USER, RULES, HEARTBEAT)
- ✅ Proactive systems (sensorium, sleep cycle, drift detection)
- ✅ Docker Compose (engine + Ollama)

### M2: Self-Improvement 🔄
Agent gets better over time through structured self-assessment.

- ✅ Prediction journal
- ✅ Pre-mortem analysis
- ✅ Drift detection
- ✅ RBT diagnosis
- ✅ Context compaction

### M3: Channels & Multi-User 🔄
Agent connects to the world and serves multiple users.

- ✅ TUI chat interface
- 🔄 Telegram channel adapter
- 🔄 Discord channel adapter
- 🔄 Web chat interface
- 🔄 Multi-user session isolation

### M4: Polish & Ship ✅ (This milestone)
Production-ready product.

- ✅ CLI (init, start, status, chat, tools, memory, config)
- ✅ Identity templates (developer, business, creative, researcher, general)
- ✅ README and documentation
- ✅ npm-publishable package
- 🔄 Cloud deployment option
- 🔄 Monitoring dashboard

## License

MIT

---

Built with 🔮 by [Greyrock Studio](https://greyrockstudios.dev)
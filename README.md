<div align="center">

# 🔮 Lodestone

### Turn any LLM into a self-improving agent that remembers everything, works proactively, and gets better over time.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-290%20passing-brightgreen.svg)](#testing)
[![Tools](https://img.shields.io/badge/tools-39%20built--in-purple.svg)](#built-in-tools)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[🌐 Website](https://lodestone.greyrockstudios.com) · [📦 npm](https://www.npmjs.com/package/lodestone) · [📚 Docs](docs/getting-started.md) · [💬 Discord](https://discord.gg/greyrock)

</div>

---

## Stop building chatbots. Start building agents.

Most LLM wrappers give you a chatbot that forgets everything when the session ends. **Lodestone gives you an agent that:**

- 🧠 **Remembers forever** — Three-layer memory (vector recall, curated wiki, session scratch). Knowledge compounds across sessions. Ask something Tuesday, get the answer instantly Thursday.
- 📈 **Improves itself** — Prediction journals, calibration loops, drift detection, skill synthesis. The agent gets better at its job over time — not just longer context windows.
- ⏰ **Works while you sleep** — Health checks, consolidation cycles, morning briefs, dream mode. The agent thinks even when you're not talking to it.
- 🛡️ **Keeps itself safe** — Quality gates, self-constraints, explainability traces, intent prediction. The agent enforces its own guardrails.
- 🎭 **Has real identity** — You define WHO it is (SOUL.md), WHAT it knows (wiki), HOW it operates (RULES.md), and WHAT it focuses on (HEARTBEAT.md). Not a blank slate — a shaped tool.
- 🔌 **Talks everywhere** — Telegram, Discord, Email, Webchat, CLI. Your agent works where you already work.

---

## Quick Start

```bash
# Install and run in 30 seconds
npx lodestone init --template developer
cd my-agent
lodestone start

# Your agent is now thinking. 🤔
# ✓ Memory system loaded
# ✓ 39 tools registered
# ✓ Self-improvement active
# ✓ Heartbeat running
```

**Requirements:** Node.js 22+ and any LLM (Ollama, OpenAI, Anthropic, or anything that speaks the OpenAI API format).

---

## Why Lodestone?

| Without Lodestone | With Lodestone |
|---|---|
| Agent forgets everything each session | Three-layer memory: vector, wiki, scratch |
| Same mistakes every time | Self-improvement: calibration, drift detection, skill synthesis |
| Only works when you talk to it | Proactive: heartbeat, sensorium, sleep cycle, morning briefs |
| No guardrails | Safety: quality gates, self-constraints, explainability |
| Blank slate personality | Real identity: SOUL.md, RULES.md, HEARTBEAT.md |
| Single channel | Multi-channel: Telegram, Discord, Email, Webchat, CLI |
| 0 tools | 39 built-in tools, tested and ready |

---

## Built-in Tools (39)

Every tool your agent needs to actually do work — not just talk about it.

| Category | Tools |
|----------|-------|
| **Knowledge** | wiki-resolve, wiki-search, wiki-write, wiki-read, smart-retrieve, decision-log |
| **Memory** | memory-store, memory-recall, resume-state |
| **Monitoring** | watchdog, business-hours |
| **Web** | web-search, web-fetch, http, search-engine, browser |
| **Code** | code-exec, shell, process-manager, diff-patch, git, lsp |
| **Files** | file-ops, archive, clipboard, screenshot |
| **Communication** | send-message, notify, voice |
| **Data** | database, secrets |
| **AI/ML** | image-gen, ocr, transcribe, vision |
| **Scheduling** | scheduler, calendar |
| **Orchestration** | coordinator, mcp-client |

All tools are TypeScript, fully tested, and use lazy imports for optional dependencies (Playwright, Tesseract, Whisper, etc.) — install only what you need.

---

## Self-Improvement Engine

The agent doesn't just answer questions. It learns from every interaction.

| System | What It Does | Schedule |
|--------|-------------|----------|
| **Prediction Journal** | Records predictions, checks outcomes, computes Brier scores | Each response |
| **Calibration Loop** | Adjusts confidence based on historical accuracy | Hourly |
| **Drift Correction** | Detects behavioral drift, injects corrective prompts | Every 6 hours |
| **Dream Mode** | Consolidates learnings, synthesizes skills, patches behavior | Nightly 3am |
| **A/B Testing** | Tests prompt variants and records outcomes | Per-response |
| **Failure Replay** | Analyzes failures, generates prevention rules | On failure |
| **Skill Synthesizer** | Creates new skills from accumulated tool sequences | During dream cycle |
| **Sleep Cycle** | Full self-improvement cycle with pre-mortems and reflection | Nightly 3am |

---

## Safety Systems

| System | What It Does |
|--------|-------------|
| **Quality Gates** | Reviews outputs by type (code, advice, sensitive) and blocks low-quality responses |
| **Self-Constraints** | Self-imposed behavioral limits approved by the agent itself |
| **Explainability** | Records decision traces showing why each action was taken |
| **Confidence Display** | Calibrated confidence scores (high/moderate/low/very-low) |
| **Failure Replay** | Replays past failures to generate prevention rules |
| **Intent Prediction** | Predicts user intent before executing tools |
| **Behavioral Learning** | Learns from corrections and adjusts future behavior |
| **Contextual Style** | Adapts tone, formality, and verbosity to context |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     IDENTITY LAYER                        │
│   SOUL.md  ·  IDENTITY.md  ·  USER.md  ·  RULES.md       │
│                  HEARTBEAT.md                             │
├──────────────────────────────────────────────────────────┤
│                     ENGINE CORE                           │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Memory       │  │ Self-         │  │ Proactive     │    │
│  │ ├ Wiki       │  │ Improvement   │  │ ├ Sensorium   │    │
│  │ ├ Vector DB  │  │ ├ Predictions │  │ ├ Sleep Cycle │    │
│  │ └ Scratch    │  │ ├ Calibration │  │ ├ Briefs      │    │
│  │              │  │ ├ Drift Det.  │  │ └ Watchdog    │    │
│  │              │  │ ├ A/B Testing │  │              │    │
│  │              │  │ └ Dream Mode  │  │              │    │
│  ├─────────────┤  ├──────────────┤  ├──────────────┤    │
│  │ Safety       │  │ Sessions     │  │ Scheduler     │    │
│  │ ├ Quality    │  │ ├ Create     │  │ ├ Cron jobs   │    │
│  │ ├ Constraints│  │ ├ Compact    │  │ ├ Intervals   │    │
│  │ ├ Explain.   │  │ ├ Persist    │  │ └ Queues      │    │
│  │ └ Intent     │  │ └ Resume     │  │              │    │
│  ├─────────────┤  ├──────────────┤  ├──────────────┤    │
│  │ Tools (39)   │  │ Channels     │  │ Plugins       │    │
│  │ ├ Knowledge  │  │ ├ Telegram   │  │ ├ onMessage   │    │
│  │ ├ Memory     │  │ ├ Discord   │  │ ├ beforeTool  │    │
│  │ ├ Web        │  │ ├ Email     │  │ ├ afterTool   │    │
│  │ ├ Code       │  │ ├ Webchat    │  │ ├ beforeResp  │    │
│  │ └ Files      │  │ └ CLI       │  │ └ afterResp   │    │
│  └─────────────┘  └──────────────┘  └──────────────┘    │
├──────────────────────────────────────────────────────────┤
│                     LLM RUNTIME                           │
│  Multi-provider · Streaming · Tool execution · Routing   │
│  (Ollama · OpenAI · Anthropic · any OpenAI-compatible)   │
└──────────────────────────────────────────────────────────┘
```

---

## Templates

Start from a template. Customize everything.

| Template | Best For | Focus |
|----------|----------|-------|
| `developer` | Software engineering | Code, PRs, debugging, git |
| `business` | Sales, CRM, operations | Pipelines, follow-ups, revenue |
| `creative` | Writing, content, marketing | Blog posts, copy, brainstorming |
| `researcher` | Literature review, analysis | Citations, data, evidence |
| `general` | All-purpose assistant | Adaptable to any domain |

Each template includes: IDENTITY.md, SOUL.md, USER.md, RULES.md, HEARTBEAT.md, and a lodestone.config.yaml.

---

## Configuration

`lodestone.config.yaml` — all options with sensible defaults:

```yaml
# LLM Provider — works with anything
llm:
  default:
    type: ollama                    # ollama | openai | anthropic
    model: glm-5.2:cloud
    baseUrl: http://127.0.0.1:11434/api

# Three-layer memory
memory:
  vectorDb:
    provider: lancedb               # Local, no server needed
    autoRecall: true                 # Auto-inject relevant memories
    autoCapture: false               # Auto-store all turns
  wiki:
    autoLint: true                  # Nightly wiki lint
    autoIndex: true                 # Auto-generate index.md

# Self-improvement (all on by default)
proactive:
  sensorium:
    enabled: true
    interval: 30m
  sleep:
    enabled: true
    schedule: "0 3 * * *"            # Dream mode at 3am
  calibration:
    enabled: true
    interval: 1h

# Safety (all on by default)
safety:
  qualityGates: true
  selfConstraints: true
  explainability: true
  confidenceDisplay: true
  failureReplay: true
  intentPrediction: true
```

---

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

---

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

// Access subsystems directly
agent.engine.memory.vector.store('key', 'value');
agent.engine.safety.explainability.getTrace('session-1');
agent.engine.improvement.skillSynthesizer.recordToolSequence('session-1', calls);
```

---

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

### Webchat
Built-in TUI chat (`lodestone chat`) works out of the box. For a web interface, use the dashboard API server with Socket.IO.

---

## Development

### Prerequisites
- Node.js 22+
- Ollama (for local LLM) or API keys for OpenAI/Anthropic

### Setup

```bash
git clone https://github.com/GreyrockStudios/lodestone.git
cd lodestone
npm install
npm run build
npm test                # 243 tests
node packages/core/dist/test/tool-tests-2.js  # 47 tool tests
```

### Project Structure

```
lodestone/
├── packages/
│   ├── core/                  # Engine runtime (52,000+ lines)
│   │   └── src/
│   │       ├── engine.ts       # Main orchestrator
│   │       ├── agent-loop.ts   # LLM → tool → response cycle
│   │       ├── sdk.ts          # Public API for embedding
│   │       ├── llm/            # Multi-provider LLM abstraction
│   │       ├── memory/         # Wiki + Vector + Scratch
│   │       ├── tools/          # 39 built-in tools
│   │       ├── session/        # Session management & persistence
│   │       ├── scheduler/      # Cron & interval job system
│   │       ├── channels/       # Telegram, Discord, Email, Webchat
│   │       ├── safety/         # Quality gates, constraints, explainability
│   │       ├── improvement/    # Calibration, drift, dream mode, skill synthesis
│   │       ├── identity/       # SOUL/IDENTITY/RULES loader
│   │       ├── plugin-system/  # Plugin hooks (5 lifecycle events)
│   │       └── utils/          # Logger, config validator, health checker
│   └── cli/                    # CLI tool
│       └── src/commands/       # init, start, status, chat, tools, memory, config, doctor
├── examples/                   # 3 example agents
├── templates/                  # 5 identity templates
├── docs/                       # Documentation
└── docker-compose.yml          # One-command deployment
```

### Adding a Tool

1. Create `packages/core/src/tools/impl/my-tool.ts`
2. Implement the `Tool` interface (definition + execute)
3. Register in `packages/core/src/tools/register-builtin.ts`
4. Export from `packages/core/src/index.ts`

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

---

<a name="testing"></a>
## Testing

```bash
npm test                           # 243 tests (146 unit + 16 integration + 17 + 8 tool)
node packages/core/dist/test/tool-tests-2.js  # 47 additional tool tests
```

**290 tests total. All passing.**

---

## Stats

| Metric | Value |
|--------|-------|
| Lines of TypeScript | 52,000+ |
| Tests | 290 (all passing) |
| Built-in tools | 39 |
| Channels | 5 (CLI, Telegram, Discord, Email, Webchat) |
| Self-improvement systems | 8 |
| Safety systems | 8 |
| Plugin hooks | 5 lifecycle events |
| Identity templates | 5 |
| Example agents | 3 |
| License | MIT |

---

## Pricing

| Tier | Price | What You Get |
|------|-------|-------------|
| **Community** | Free | Everything. MIT licensed. Forever. |
| **Pro** | $197 ($97 early access) | Commercial license, priority support, premium channels, MCP client, setup wizard, automation recipes |
| **Enterprise** | $997 | Everything in Pro + 5-seat license, custom tools, dedicated support, on-premise, SLA |

[Get Pro Early Access →](https://lodestone.greyrockstudios.com#early-access)

---

## License

MIT — do whatever you want. See [LICENSE](LICENSE).

---

<div align="center">

**Built with 🔮 by [Greyrock Studio](https://greyrockstudios.com)**

[Website](https://lodestone.greyrockstudios.com) · [GitHub](https://github.com/GreyrockStudios/lodestone) · [npm](https://www.npmjs.com/package/lodestone) · [Docs](docs/getting-started.md)

</div>
# Getting Started with Lodestone

> 5-minute quickstart. By the end, you'll have a running agent with memory, tools, and a web chat interface.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 22+ | `node --version` |
| npm | 10+ | `npm --version` |
| Ollama (optional) | any | `ollama --version` |

You need an LLM provider. The easiest is [Ollama](https://ollama.com) running locally — but Lodestone also supports OpenAI and Anthropic APIs.

## 1. Install

```bash
npm install -g lodestone
```

Or clone and build from source:

```bash
git clone https://github.com/greyrockstudios/lodestone.git
cd lodestone
npm install
npm run build
```

## 2. Initialize a Workspace

```bash
lodestone init
```

This launches an interactive wizard that creates:

```
my-agent/
├── lodestone.config.yaml    # Agent configuration
├── .env                     # Environment variables
├── .gitignore
└── workspace/
    ├── IDENTITY.md          # Who the agent is
    ├── SOUL.md              # Personality and principles
    ├── USER.md              # Who you are
    ├── RULES.md             # Operating rules
    ├── HEARTBEAT.md         # Proactive task config
    ├── memory/
    │   ├── wiki/            # Curated knowledge base
    │   └── 00-inbox/        # Quick capture
    └── data/
        ├── lancedb/         # Vector database
        └── logs/
```

You can skip prompts with flags:

```bash
lodestone init --name "Jarvis" --user "Tony" --model glm-5.2:cloud --provider ollama --path ./my-agent --yes
```

### Templates

| Template | Vibe |
|----------|------|
| `general` | Balanced assistant |
| `developer` | Coding-focused |
| `business` | Operations-focused |
| `creative` | Writing-focused |
| `researcher` | Research-focused |

## 3. Configure

Edit `lodestone.config.yaml`. Here's every option:

```yaml
# ─── LLM ─────────────────────────────────────────────────────────────
llm:
  default:
    type: ollama              # ollama | openai | anthropic | custom
    model: glm-5.2:cloud      # Model identifier
    baseUrl: http://127.0.0.1:11434/api  # API endpoint
    apiKey: ${OPENAI_API_KEY} # For openai/anthropic (not needed for ollama)
    contextWindow: 128000     # Max context tokens
    maxTokens: 8192           # Max output tokens
    reasoning: false          # Does model support reasoning/thinking?
  routes:                     # Optional: route tasks to different models
    fast:
      type: ollama
      model: qwen3:4b
      baseUrl: http://127.0.0.1:11434/api

# ─── Channels ────────────────────────────────────────────────────────
channels:
  webchat:
    type: webchat
    enabled: true             # Enable web chat UI
    port: 3000                # HTTP port
    corsOrigin: "*"           # CORS origin
  telegram:
    type: telegram
    enabled: false            # Set true + add botToken to enable
    botToken: ${TELEGRAM_BOT_TOKEN}
    streaming: true           # Stream responses
  discord:
    type: discord
    enabled: false
    botToken: ${DISCORD_BOT_TOKEN}
    channelId: "1234567890"
    streaming: true

# ─── Memory ──────────────────────────────────────────────────────────
memory:
  vectorDb:
    provider: lancedb
    path: ./workspace/data/lancedb
    embedding:
      provider: ollama        # ollama | openai
      model: nomic-embed-text
      dimensions: 768
    autoRecall: true          # Auto-inject relevant memories into context
    autoCapture: false        # Auto-store conversation summaries
  wiki:
    path: ./workspace/memory/wiki
    autoLint: true            # Validate wiki pages on write
    autoIndex: true           # Auto-maintain wiki index
  scratch:
    path: ./workspace/data/scratch.db

# ─── Identity ────────────────────────────────────────────────────────
identity:
  dir: ./workspace            # Directory with IDENTITY.md, SOUL.md, etc.

# ─── Session ─────────────────────────────────────────────────────────
session:
  compactionThreshold: 0.5    # Compact context at 50% capacity
  keepRecentCount: 10         # Messages to keep after compaction
  maxEntries: 200             # Max messages per session
  pruneAfter: 7d              # Prune old sessions

# ─── Proactive ───────────────────────────────────────────────────────
proactive:
  sensorium:                  # Periodic environment check
    enabled: true
    interval: 30m
  sleep:                      # Nightly self-improvement cycle
    enabled: true
    schedule: "0 3 * * *"     # 3 AM daily
    timezone: "America/Toronto"
  drift:                      # Weekly identity drift check
    enabled: true
    schedule: "0 9 * * 1"     # 9 AM Monday

# ─── Scheduler ───────────────────────────────────────────────────────
scheduler:
  maxConcurrent: 4            # Max concurrent scheduled jobs

# ─── Logging ─────────────────────────────────────────────────────────
logging:
  level: info                 # debug | info | warn | error
  file: ./workspace/data/logs/lodestone.log

# ─── Safety ──────────────────────────────────────────────────────────
safety:
  customTiers: {}             # Override tool capability tiers

# ─── Cost Tracking ───────────────────────────────────────────────────
costTracking:
  enabled: false
  monthlyBudget: 100          # USD

# ─── Model Routing ───────────────────────────────────────────────────
modelRouting:
  enabled: false
  defaultModel: glm-5.2:cloud
  escalationModel: gpt-4o
  cheapModel: qwen3:4b

# ─── Auth ────────────────────────────────────────────────────────────
auth:
  users: []                   # Multi-user config
  tokens: {}                  # API tokens
```

## 4. Start the Agent

```bash
lodestone start
```

You'll see:

```
[Lodestone] Starting engine...
[Lodestone] Identity loaded: Jarvis
[Lodestone] Safety system initialized
[Lodestone]   Capabilities: 15 tools across 4 tiers
[Lodestone]   Behavioral rules: 0 active
[Lodestone] Engine started. Agent is thinking.
```

## 5. Connect via WebChat

Open `http://localhost:3000` in your browser. You'll see a chat interface. Type a message and press Enter.

The agent will:
1. Recall relevant memories (if `autoRecall` is on)
2. Construct a system prompt from your identity files
3. Call the LLM
4. Execute any tool calls
5. Stream the response back to you

## 6. Stop Gracefully

Press `Ctrl+C` in the terminal. The engine stops channels, cancels scheduled jobs, and shuts down cleanly.

```
[Lodestone] Stopping engine...
[Lodestone] Engine stopped.
```

## 7. Built-in Tools

Your agent comes with 15 tools out of the box:

| Tool | Description | Tier |
|------|-------------|------|
| `wiki-resolve` | Resolve `[[wikilinks]]` to page content | Public |
| `wiki-search` | Search wiki pages by title, slug, or tag | Public |
| `smart-retrieve` | Retrieve relevant wiki pages + memories | Public |
| `decision-log` | Record and search decisions | Controlled |
| `resume-state` | Save/load session state across restarts | Controlled |
| `watchdog` | Set expected-outcome watches with deadlines | Controlled |
| `business-hours` | Check if it's business hours | Public |
| `web-search` | Search the web for current information | Public |
| `web-fetch` | Fetch and extract readable content from a URL | Public |
| `file-ops` | Read, write, list, and search files | Controlled |
| `code-exec` | Execute Python or Node.js code in a sandbox | Restricted |
| `calendar` | Manage calendar events and find free slots | Controlled |
| `vision` | Analyze images and visual content | Controlled |
| `voice` | Text-to-speech and speech-to-text | Controlled |
| `coordinator` | Spawn and manage sub-agent tasks | Restricted |

## Next Steps

## 8. Self-Improvement Features

Lodestone doesn't just respond — it gets better over time:

| Feature | Schedule | What It Does |
|---------|----------|-------------|
| **Calibration loop** | Hourly | Resolves expired predictions, computes Brier scores, adjusts confidence |
| **Drift correction** | Every 6h | Detects behavior drift from identity principles, injects corrective prompts |
| **Dream mode** | Nightly 3am | Analyzes recent conversations, extracts behavioral rules, proposes improvements |
| **A/B testing** | Per response | Tests prompt variants, records outcomes, calculates statistical significance |
| **Self-patching** | Via sleep cycle | Proposes code patches based on improvement opportunities (human approval required) |
| **Memory compounding** | On wiki write | Auto-extracts entities, detects contradictions, builds knowledge graph |
| **Proactive intelligence** | Every 30min | Scans for proactive opportunities (reminders, suggestions, follow-ups) |

## 9. Health Check

Run `lodestone doctor` to verify your setup:

```bash
lodestone doctor
```

This runs 25 checks: config validity, workspace structure, identity files, LLM connectivity, port availability, and more.

## Next Steps

- **[Architecture →](architecture.md)** — Understand the system design and component interactions
- **[API Reference →](api-reference.md)** — Embed Lodestone in your own application with the SDK
- **[Examples →](../examples/)** — Pre-built agent configurations (business ops, researcher, customer support)
- **[Contributing →](../CONTRIBUTING.md)** — Add your own tools, channels, or improvements
- Edit `workspace/SOUL.md` to shape your agent's personality
- Add a Telegram or Discord channel in the config
- Write a custom tool (see [API Reference](api-reference.md#tool-interface))
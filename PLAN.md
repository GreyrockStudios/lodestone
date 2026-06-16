# Lodestone — Project Plan

## Vision

Take any LLM from "answers questions" to "thinks ahead, remembers everything, gets better over time, and runs itself."

## Principles

1. **Behavioral layer is the product** — Memory, proactivity, self-improvement are first-class primitives, not plugins
2. **Identity is injectable** — Users provide their agent's personality, rules, and priorities
3. **Knowledge starts empty** — Clean wiki scaffold with optional templates
4. **One command to deploy** — Docker Compose or `lodestone start`
5. **Own the runtime** — No dependency on external agent frameworks

## Milestones

### M1: First Breath (Target: 2-3 weeks)
Docker Compose boots an agent that starts thinking proactively within 5 minutes.

**Scope:**
- Runtime: LLM orchestration (Ollama first, multi-provider later), tool execution, streaming
- Memory: Wiki scaffold + LanceDB vector store + scratch buffer
- Identity: Config files (SOUL.md, IDENTITY.md, RULES.md, HEARTBEAT.md)
- Proactive: Sensorium health check, basic sleep cycle
- MCP Tools: wiki-resolve, smart-retrieve, decision-log, scratch-buffer
- Deployment: Docker Compose (engine + Ollama + LanceDB)

**M1 Checklist:**
- [ ] Runtime core (LLM abstraction, tool execution, streaming responses)
- [ ] Session management (create, resume, compaction)
- [ ] MCP tool server framework
- [ ] Wiki scaffold (empty, with templates)
- [ ] Vector memory (LanceDB, embed, recall)
- [ ] Scratch buffer (key-value with TTL)
- [ ] Decision log (decisions, search, supersede)
- [ ] Wiki resolver (wikilink resolution)
- [ ] Smart retrieve (relevance-ranked retrieval)
- [ ] Identity loader (read SOUL/IDENTITY/RULES/HEARTBEAT)
- [ ] Sensorium (health check script)
- [ ] Sleep cycle (consolidation cron)
- [ ] Docker Compose (engine + Ollama + LanceDB)
- [ ] Setup wizard (`lodestone init`)
- [ ] 5-minute proactive test

### M2: Self-Improvement (Target: 2 weeks after M1)
Agent gets better over time through structured self-assessment.

**Scope:**
- Prediction journal (log predictions, review outcomes, calibration)
- Pre-mortem analysis (before major decisions)
- Drift detection (behavior vs core principles)
- RBT diagnosis (Roses/Buds/Thorns self-healing)
- Skill evolution (lesson tracking, promotion to core)
- Contradiction protocol (knowledge integrity)
- Context compaction protocol

### M3: Channels & Multi-User (Target: 2 weeks after M2)
Agent connects to the world and serves multiple users.

**Scope:**
- Telegram channel adapter
- Discord channel adapter
- Web chat interface
- Multi-user session isolation
- Business hours awareness
- Auth system

### M4: Polish & Ship (Target: 2 weeks after M3)
Production-ready product.

**Scope:**
- CLI (`lodestone init/start/stop/status`)
- Templates (developer, business ops, creative, researcher, general)
- Documentation
- npm package
- Cloud deployment option
- Monitoring dashboard

## Tech Stack (Decision Pending)

| Component | Options | Lean Towards |
|-----------|---------|--------------|
| Language | TypeScript, Rust, Go | TypeScript (fastest to ship, MCP ecosystem) |
| LLM Runtime | Custom orchestration over Ollama/OpenAI/etc APIs | Custom (TypeScript) |
| Vector DB | LanceDB, Chroma, Qdrant | LanceDB (local-first, no server) |
| Wiki Store | Markdown files | Markdown files (git-trackable) |
| Scheduler | node-cron, bull, custom | Custom (embedded) |
| Container | Docker Compose | Docker Compose |
| CLI | Commander.js, oclif | Commander.js (lighter) |

## What We're Extracting From Flint

These components are being generalized from our existing Flint setup:

| Flint Component | Lodestone Equivalent | Status |
|----------------|---------------------|--------|
| openclaw.json config | lodestone.config.yaml | Needs building |
| SOUL.md, IDENTITY.md, etc. | Identity layer (same format) | Ready to extract |
| AGENTS.md | RULES.md (generalized) | Needs rewriting |
| HEARTBEAT.md | HEARTBEAT.md (same format) | Ready to extract |
| LanceDB memory plugin | Built-in memory system | Needs rebuilding |
| 9 MCP plugins | Built-in tool servers | Needs generalizing |
| 23 scripts | Proactive system scripts | Needs generalizing |
| 19 cron jobs | Scheduler config | Needs generalizing |
| 97 skills | Skills framework + templates | Needs framework |
| Wiki (615 pages) | Empty scaffold + templates | Content removed, structure kept |
| Memory.md index | Auto-generated index | Needs building |

## What We're NOT Extracting

- Greyrock identity (SOUL content, IDENTITY content)
- Greyrock knowledge (wiki pages about web dev, SEO, Canadian law)
- Greyrock projects (blogs, Kronos, Cente's, etc.)
- Greyrock infrastructure (server IPs, Cloudflare keys, API tokens)
- Greyrock cron jobs (blog pipelines, lead follow-ups)
- OpenClaw-specific config (channel tokens, MCP server config format)

## Repository Structure (Proposed)

```
lodestone/
├── README.md
├── ADRS.md
├── PLAN.md
├── LICENSE
├── docker-compose.yml
├── packages/
│   ├── core/                    # Runtime engine
│   │   ├── src/
│   │   │   ├── llm/            # LLM abstraction (Ollama, OpenAI, etc.)
│   │   │   ├── tools/          # Tool execution framework
│   │   │   ├── session/        # Session management
│   │   │   ├── streaming/      # Response streaming
│   │   │   ├── scheduler/      # Cron/scheduler system
│   │   │   └── channels/       # Channel adapters (Telegram, Discord, etc.)
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── memory/                  # Memory system
│   │   ├── src/
│   │   │   ├── wiki/           # Wiki store (markdown files)
│   │   │   ├── vector/          # Vector DB (LanceDB)
│   │   │   ├── scratch/        # Session scratch buffer
│   │   │   └── index/          # Auto-generated wiki index
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── improvement/             # Self-improvement system
│   │   ├── src/
│   │   │   ├── predictions/    # Prediction journal
│   │   │   ├── premortems/     # Pre-mortem analysis
│   │   │   ├── drift/          # Drift detection
│   │   │   ├── rbt/            # RBT diagnosis (Roses/Buds/Thorns)
│   │   │   ├── skills/         # Skill evolution
│   │   │   └── contradiction/  # Knowledge integrity
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── proactive/               # Proactive systems
│   │   ├── src/
│   │   │   ├── sensorium/      # Health monitoring
│   │   │   ├── sleep/          # Sleep cycle (consolidation)
│   │   │   ├── brief/          # Morning brief generation
│   │   │   └── watchdog/      # Expected outcome tracking
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── tools/                   # MCP tool servers
│   │   ├── wiki-resolve/
│   │   ├── smart-retrieve/
│   │   ├── decision-log/
│   │   ├── scratch-buffer/
│   │   ├── resume-state/
│   │   ├── subagent-handoff/
│   │   ├── file-lock/
│   │   ├── business-hours/
│   │   └── watchdog/
│   └── cli/                     # CLI tool
│       ├── src/
│       │   ├── commands/        # init, start, stop, status, config
│       │   └── templates/       # Identity + wiki templates
│       ├── package.json
│       └── tsconfig.json
├── docker/
│   ├── Dockerfile.core
│   ├── Dockerfile.tools
│   └── entrypoint.sh
├── templates/                   # Starter kits
│   ├── developer/
│   ├── business/
│   ├── creative/
│   ├── researcher/
│   └── general/
└── scripts/                     # Proactive scripts (generalized)
    ├── sensorium.sh
    ├── drift-detection.sh
    ├── rbt-diagnosis.sh
    ├── morning-brief.sh
    └── sleep-cycle.sh
```

## Next Steps

1. Finalize tech stack decisions
2. Set up repo structure
3. Build runtime core (LLM abstraction, tool execution)
4. Build memory system (wiki + vector + scratch)
5. Port and generalize MCP tools
6. Build identity loader
7. Build sensorium
8. Docker Compose integration test
9. 5-minute proactive test
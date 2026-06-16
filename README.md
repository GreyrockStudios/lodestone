# Lodestone 🔮

> Take any LLM from "answers questions" to "thinks ahead, remembers everything, gets better over time, and runs itself."

Lodestone is a standalone agent engine that gives LLMs persistent memory, self-improvement loops, proactive scheduling, and a curated knowledge system — all deployable in one command.

## What It Does

- **Persistent Memory** — 3-layer system: vector recall, curated wiki, session scratch. Knowledge compounds across sessions.
- **Self-Improvement** — Prediction journals, pre-mortems, drift detection, skill evolution. The agent gets better at its job over time.
- **Proactive Scheduling** — Health checks, consolidation cycles, drift detection, morning briefs. The agent thinks even when you're not talking to it.
- **Identity Injection** — Users provide their agent's personality, rules, and priorities. Lodestone gives it the machinery to act on them.
- **Knowledge Compounding** — Start empty or from templates. The wiki grows, cross-links, and gets linted automatically.

## Architecture

```
┌─────────────────────────────────────┐
│         IDENTITY LAYER              │  ← User provides (SOUL, IDENTITY, USER, RULES, HEARTBEAT)
├─────────────────────────────────────┤
│         ENGINE (Lodestone Core)      │  ← This repo
│  ┌───────────────────────────────┐  │
│  │ Memory System                  │  │
│  │  ├ Wiki (curated knowledge)    │  │
│  │  ├ Vector DB (semantic recall)│  │
│  │  └ Scratch (session state)    │  │
│  ├───────────────────────────────┤  │
│  │ Self-Improvement               │  │
│  │  ├ Prediction journal          │  │
│  │  ├ Pre-mortems                  │  │
│  │  ├ Skill evolution              │  │
│  │  └ Contradiction protocol       │  │
│  ├───────────────────────────────┤  │
│  │ Proactive Systems               │  │
│  │  ├ Sensorium (health loops)     │  │
│  │  ├ RBT Diagnosis (self-heal)    │  │
│  │  ├ Drift detection              │  │
│  │  ├ Sleep cycle (consolidation)  │  │
│  │  └ Context management           │  │
│  ├───────────────────────────────┤  │
│  │ MCP Tools                       │  │
│  │  ├ wiki-resolve                  │  │
│  │  ├ smart-retrieve               │  │
│  │  ├ decision-log                  │  │
│  │  ├ watchdog                      │  │
│  │  ├ business-hours                │  │
│  │  ├ resume-state                  │  │
│  │  ├ subagent-handoff              │  │
│  │  ├ file-lock                     │  │
│  │  └ scratch-buffer                 │  │
│  ├───────────────────────────────┤  │
│  │ Skills Framework                  │  │
│  │  ├ Skill loader/renderer          │  │
│  │  ├ Lesson tracking                │  │
│  │  └ Template library               │  │
│  └───────────────────────────────┘  │
├─────────────────────────────────────┤
│         RUNTIME (Lodestone Runtime) │  ← Built in-house
│  LLM orchestration, tool execution, │
│  streaming, session management,      │
│  channel routing, auth               │
└─────────────────────────────────────┘
```

## Quick Start

```bash
# Install globally
npm install -g lodestone

# Create a new agent
lodestone init

# Or with a template
lodestone init --template developer

# Start
lodestone start

# Or with Docker
docker compose up
```

## Milestone 1

Docker Compose that boots an agent with:
- ✅ Full memory system (wiki + vector + scratch)
- ✅ Self-improvement loops (prediction journal, drift detection)
- ✅ Proactive sensorium (health checks, self-diagnosis)
- ✅ Identity injection (user provides SOUL, rules, heartbeat)
- ✅ Agent thinks proactively within 5 minutes of boot

## License

TBD
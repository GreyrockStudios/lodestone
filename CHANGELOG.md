# Changelog

All notable changes to Lodestone are documented here. Grouped by milestone.

## M15: Full Audit + Dead Module Wiring (2026-06-18)

### Added
- **SDK processMessage wired** — Was a no-op (echoed user message), now calls `engine.processMessage()` → `agentLoop.run()`
- **Engine AgentLoop reference** — Added `setAgentLoop()`, `getAgentLoop()`, `processMessage()` to engine
- **CostTracker wired** — Token usage now recorded in agent loop after each response
- **Session persistence** — Optional SQLite persistence initialized in `engine.start()` (requires `better-sqlite3` optional peer dep)
- **Self-constraints in agent loop** — Active constraints injected into system prompt; tool calls checked against constraint patterns
- **Contextual style in agent loop** — Tone, formality, and verbosity adaptation based on channel, time of day, and conversation depth
- **Confidence scoring in agent loop** — Response confidence calculated and logged after each LLM response
- **Explainability traces** — Tool call steps recorded in explainability layer
- **Quality gate enforcement** — When gate returns `block`, output replaced with safe fallback
- **Session cleanup** — Hourly scheduled job removes stale sessions (24h+)
- **Tool timeout enforcement** — 30s default via `Promise.race`, configurable per-tool
- **Plugin hooks completed** — All 5 hooks fire (onMessage, beforeTool, afterTool, beforeResponse, afterResponse)
- **Public API exports** — All 15 tools exported from `@lodestone/core`, package.json `exports` field
- **Email channel peer deps** — Added `nodemailer`, `imap`, `better-sqlite3` as optional peer dependencies
- **17 new Phase 4 tests** — Session cleanup, tool timeout, coordinator tool (235 total)
- **Root-level test:dogfood and test:all scripts**
- **Dockerfile.core fixed** — Now copies CLI package and examples, builds both packages

### Changed
- **SafetySystem created before ImprovementSystem** — Reordered in engine constructor so ImprovementSystem can reference `safety.behavioralLearning`
- **README polished** — Architecture diagram, 15-tool table, self-improvement/safety feature tables, example agents, SDK usage, accurate stats
- **0 dead modules remaining** — All 6 previously-unwired modules now integrated into agent loop

## M14: Sprint 6 — Multi-Agent Coordination (2026-06-18)

### Added
- **Coordinator tool** — LLM-callable spawn/status/list/cancel for sub-agent tasks
- **ToolContext extended** with optional `engine` reference for coordinator access
- 15 built-in tools total (coordinator added as 15th)

## M13: Sprint 5 — Dream Mode + A/B Testing + Self-Patching (2026-06-18)

### Added
- **Dream mode wired** — Nightly 3am scheduled job analyzes conversations, extracts behavioral rules, proposes self-improvements
- **A/B testing wired** — Variant selection injected into system prompt, outcome recording after each response
- **Self-patching** — Wired through sleep cycle post-cycle hooks
- ImprovementConfig extended with sessionManager/behavioralLearning

## M12: Sprint 4 — Calibration + Drift Correction + Tool Ecosystem (2026-06-18)

### Added
- **Calibration loop wired** — Hourly scheduled job resolves predictions, computes Brier scores, adjusts confidence
- **Drift correction wired** — 6-hour scheduled job detects behavior drift, generates corrective prompt injections
- **All 14 built-in tools registered** — wiki-resolve, wiki-search, smart-retrieve, decision-log, resume-state, watchdog, business-hours, web-search, web-fetch, file-ops, code-exec, calendar, vision, voice
- Dashboard providers updated with calibration and drift data

## M11: Sprint 3 — Memory Compounding + Channel Reliability + Error Recovery (2026-06-18)

### Added
- **Memory compounding wired** — Entity extraction, contradiction detection, knowledge graph auto-population
- **Channel reliability** — Retry with exponential backoff, rate limiting (token bucket), message splitting at sentence/word boundaries, channel health monitoring
- **Agent loop error recovery** — LLM retry with 3x backoff, tool retry 2x, graceful degradation on failures
- **Plugin hooks wired** — into agent loop (beforeTool, afterTool, onMessage, beforeResponse, afterResponse)
- 218 tests pass (32+24+146+16), build clean

## M10: Sprint 2 — Logging + Proactive Intelligence (2026-06-18)

### Added
- **Structured logger** — Replaces console.log across 14 engine/channel/safety/memory modules
- **ProactiveIntelligence wired** — Into engine with scheduled check job and dashboard provider
- Behavioral rules injected into system prompt

## M9: Sprint 1 — P0 Integration Wiring (2026-06-18)

### Added
- **6 gap modules wired** into agent loop
- **Dashboard reachability** — Dashboard starts with engine
- **Config validation** — Validated on startup
- 146 tests pass, dogfood 8/8 passes

## M8: Dogfood (2026-06-18)

### Added
- Two full rounds of real LLM testing
- 12 bugs found and fixed
- Core loop verified end-to-end: LLM → tool call → Lodestone execution (with safety) → result → LLM → response
- Session persistence confirmed, streaming confirmed
- All 214 tests pass

## M7: Production Hardening (2026-06-17)

### Added
- 6 sprints of quality work: integration wiring, staple features (session persistence, retry/fallback, rate limiting, health checks, auth, hot-reload), ease of use (onboarding, CLI expansion, dashboard real-time, migrations), differentiators (dream mode, contradiction detection, skill synthesis, failure replay, confidence transparency, self-constraints, explainability, contextual identity), new capabilities (cost tracking, multi-model routing, email, calendar, webhooks, voice, vision, A/B testing), quality (any types removed, error hierarchy, 146 tests, multi-user auth, knowledge transfer, undo system)

## M6: Competitive Gaps (2026-06-17)

### Added
- 10 capability gaps built and wired: capability tiers, behavioral learning, evidence-gated memory, truth-binding, intent prediction, web dashboard, quality gates, knowledge graph, self-patching, one-line install

## M5: TUI v2 (2026-06-16)

### Added
- Streaming responses, live tool indicators, improvement dashboard, slash commands (/predict, /rbt, /drift, /lessons, /sleep), scroll navigation, channel status

## M4: Polish & Ship (2026-06-16)

### Added
- **CLI** — Commander.js-based command-line interface with commands: `init`, `start`, `status`, `chat`, `tools list`, `memory stats`, `config show`, `config set`
- **Identity templates** — Five pre-built persona templates (developer, business, creative, researcher, general)
- **README.md** — Complete project README with architecture, quick start, configuration reference, and development guide
- **CHANGELOG.md** — This file
- **Root package.json** — Made npm-publishable with `bin`, `files`, and workspace scripts
- **CLI package** — `packages/cli/` with TypeScript, Commander.js, and chalk

## M3: Channels (2026-06-16)

### Added
- **TUI chat v4** — Boot inside TUI, all exit paths work (/quit, /exit, Escape, Ctrl+C)
- **TUI chat v3** — Markdown messages, Box status bar, Container chat log
- **TUI chat v2** — Input at bottom, status above, messages fill rest
- **TUI chat v1** — Editor on top, status bar below, messages fill rest
- **pi-tui integration** — Terminal UI framework

## M2: Self-Improvement (2026-06-15)

### Added
- Agent loop: core LLM → tool → response cycle
- Boot sequence: engine boots, loads identity, registers tools, starts scheduler

### Changed
- Default model switched from qwen3:8b to glm-5.1:cloud

## M1: First Breath (2026-06-14)

### Added
- **LIVE: Engine boots, connects to Ollama, qwen3:8b responds** — End-to-end working agent
- **Integration tests: 15/15 passing** — Core functionality validated
- **TypeScript compiles clean** — 22 JS files, 2844 lines
- **Sensorium and sleep cycle scripts** — Proactive health monitoring and consolidation
- **Agent loop and boot sequence** — The thinking engine
- **Memory system and built-in tools** — Wiki store, vector memory, scratch buffer, and 7 MCP-style tools
- **Initial scaffold** — Project structure, package.json, Docker Compose, ADRs

### Fixed
- LLM provider: use OpenAI-compatible endpoint for Ollama
- LLM: use .chat() for Ollama, upgrade AI SDK to v6
- Suppress AI SDK v6 system message warning

## Pre-M1 (2026-06-13)

### Added
- Project vision and plan (PLAN.md)
- Architecture decision records (ADRS.md)
- Docker Compose configuration (engine + Ollama)
- Initial package structure (core, cli planned)
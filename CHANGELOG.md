# Changelog

All notable changes to Lodestone are documented here. Grouped by milestone.

## M4: Polish & Ship (2026-06-16)

### Added
- **CLI** — Commander.js-based command-line interface with commands: `init`, `start`, `status`, `chat`, `tools list`, `memory stats`, `config show`, `config set`
- **Identity templates** — Five pre-built persona templates:
  - `developer` — Software engineering agent (coding, PRs, debugging, git)
  - `business` — Business operations agent (CRM, pipelines, follow-ups)
  - `creative` — Writer/content agent (blog posts, copy, brainstorming)
  - `researcher` — Research agent (literature review, citations, data analysis)
  - `general` — General-purpose assistant (improved from M1)
- **README.md** — Complete project README with architecture, quick start, configuration reference, and development guide
- **CHANGELOG.md** — This file, derived from git history
- **Root package.json** — Made npm-publishable with `bin`, `files`, and workspace scripts
- **CLI package** — `packages/cli/` with TypeScript, Commander.js, and chalk

### Changed
- Improved general template identity files with better placeholder guidance
- Updated tsconfig.json to reference both core and cli packages
- Updated root package.json with proper npm metadata, keywords, and bin field

## M3: Channels (2026-06-16)

### Added
- **TUI chat v4** — Boot inside TUI, all exit paths work (/quit, /exit, Escape, Ctrl+C)
- **TUI chat v3** — Markdown messages, Box status bar, Container chat log
- **TUI chat v2** — Input at bottom, status above, messages fill rest
- **TUI chat v1** — Editor on top, status bar below, messages fill rest
- **pi-tui integration** — Terminal UI framework (same as OpenClaw)

### Fixed
- TUI crash: add missing Markdown theme properties (underline, strikethrough, linkUrl, quoteBorder, highlightCode)
- TUI: add tui.start(), fix identity path (identity.identity.name)
- TUI: clean exit on /quit, /exit, Escape, and Ctrl+C

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
- Upgrade to AI SDK v6, fix streaming, fix model compatibility
- Suppress AI SDK v6 system message warning

## Pre-M1 (2026-06-13)

### Added
- Project vision and plan (PLAN.md)
- Architecture decision records (ADRS.md)
- Docker Compose configuration (engine + Ollama)
- Initial package structure (core, cli planned)
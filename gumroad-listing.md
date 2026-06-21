# Gumroad Product Listing — Lodestone Pro

## Product Name
Lodestone Pro — Self-Improving AI Agent Engine (39 Tools)

## Price
$97 (Early Access — first 50 buyers, normally $197)

## Description

**Turn any LLM into a self-improving agent that remembers everything, works proactively, and gets better over time.**

Lodestone is a standalone agent engine built in TypeScript. It gives any LLM (OpenAI, Anthropic, Ollama, local models) persistent memory, self-improvement loops, proactive scheduling, and 39 built-in tools — all deployable in one command.

## What's Included

### Pro License ($97 Early Access)
- ✅ Full source code (52,000+ lines TypeScript)
- ✅ 39 built-in tools (wiki, memory, web search, code execution, git, browser, database, scheduling, LSP, and more)
- ✅ 290 passing tests
- ✅ Self-improvement engine (prediction journals, calibration, drift detection, skill synthesis)
- ✅ Proactive scheduling (heartbeat, sleep cycle, sensorium, watchdog)
- ✅ Safety systems (quality gates, self-constraints, explainability traces, intent prediction)
- ✅ Multi-channel support (Telegram, Discord, Email, Webchat)
- ✅ 5 identity templates (Developer, Business, Creative, Researcher, General)
- ✅ MCP client integration
- ✅ Docker Compose deployment
- ✅ Commercial license
- ✅ Lifetime updates
- ✅ Priority email support

### Quick Start
```bash
npx lodestone init --template developer
cd my-agent
lodestone start
```

Your agent boots up, loads its identity, initializes memory, registers 39 tools, and starts its heartbeat. It works proactively — even when you're not watching.

### Architecture
- **Identity Layer** — SOUL.md, IDENTITY.md, USER.md, RULES.md, HEARTBEAT.md
- **Engine Core** — Memory (LanceDB + Markdown wiki), Self-Improvement, Sensorium, Safety, Sessions, Scheduler, Tools
- **Runtime** — Custom LLM orchestration with streaming, tool execution, Socket.IO webchat

### Tech Stack
TypeScript · LanceDB · Node.js · Socket.IO · Docker · Markdown

### Requirements
- Node.js 18+
- Any LLM API (OpenAI, Anthropic, Ollama, LM Studio)
- Optional: Docker, PostgreSQL, Playwright

## Tags
AI, agent, LLM, automation, TypeScript, open source, self-improving, RAG, vector memory, chatbot, framework

## FAQ
**Is this open source?** Yes — Community edition is MIT licensed. Pro adds commercial license, priority support, and premium channels.

**Can I use my own LLM?** Yes — anything that speaks the OpenAI API format works. OpenAI, Anthropic, Ollama, LM Studio, vLLM, etc.

**Do I need Docker?** No — but it's recommended for production. Docker Compose included.

**Can I extend it?** Yes — plugin system, custom tools, MCP client, webhooks. Full TypeScript SDK.
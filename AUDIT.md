# Lodestone — Full Audit & Improvement Plan v2

## Current State

- **22,276 lines total** (20,087 source + 2,189 tests)
- **56/56 tests passing** (32 gap + 24 Phase 3)
- **TypeScript compiles clean**
- **74 source files** across safety, improvement, memory, channels, tools, utils, dashboard, streaming, TUI, session, scheduler, identity, LLM, plugin-system, sdk

---

## Sprint 1 — Fix What's Broken (P0)

*Wiring work — no new modules, just connecting what exists.*

1. **Wire dashboard data providers** — Engine never calls `registerProvider()`. Every endpoint returns empty JSON. Wire safety tiers, rules, promotion queue, truth guards, intent stats, quality decisions, predictions, drift, calibration, patches, subagents, memory stats, channel health.

2. **Register 4 new tools** — `web-search`, `web-fetch`, `file-ops`, `code-exec` exist in `tools/impl/` but aren't exported from `tools/index.ts` or registered in `main.ts`. Export + register.

3. **Wire calibration/drift/patch/proactive into heartbeat & sleep cycle** — All built, none called periodically. Add to SleepCycle phases or scheduled jobs.

4. **Wire multi-agent coordinator into engine** — `MultiAgentCoordinator` exists but engine doesn't expose it or use it for sub-agent spawning.

5. **Wire memory compounding into wiki writes** — `processWikiWrite()` exists, never triggered.

6. **Wire plugin system into engine** — `PluginManager` (587 lines) exists, compiles, but engine doesn't initialize it or call hooks.

7. **Wire SDK as primary agent factory** — `createAgent()` (591 lines) exists but `main.ts` doesn't use it.

8. **Fix console.log in production** — `memory/knowledge-graph.ts:165`, `memory/vector-memory.ts:90`. Migrate to Logger.

9. **Fix patch automation templates** — `proposeFromTemplates()` uses placeholder `src/placeholder.ts`. Needs real file scanning.

---

## Sprint 2 — Staple Features (P1)

*What every agent framework needs but we're missing.*

10. **Session persistence** — SQLite-backed session storage. Restart currently loses all conversation history.

11. **Graceful shutdown** — Drain in-flight tool calls, save sessions, notify channels, then exit.

12. **LLM retry + fallback** — `llm/provider.ts` has no retry. One 503 kills the response. Add exponential backoff, fallback model, circuit breaker.

13. **LLM rate limiting** — Per-minute token budget, configurable limit, circuit breaker. Guard against runaway API spend.

14. **Real health checks** — `/health` returns `{ status: 'running' }` but doesn't check LLM connectivity, channel health, or disk space.

15. **WebChat auth** — Currently anyone with the URL can chat. Add token-based auth, rate limiting.

16. **Config hot-reload** — Watch config file, apply non-critical changes without restart.

---

## Sprint 3 — Ease of Use (P2)

*Making it usable by someone who didn't build it.*

17. **Fix onboarding** — Fragile readline, no validation, no defaults shown, no back option.

18. **Config init command** — `lodestone config init` generates example config with all options documented.

19. **Expand CLI** — Add `start`, `stop`, `status`, `channels list`, `tools list`, `logs --tail` commands.

20. **Dashboard real-time updates** — WebSocket push for agent state changes, new messages, tool calls, safety events.

21. **Dashboard log viewer** — View structured logs from the dashboard, filter by level/module.

22. **Migration system** — Version field in config, `lodestone migrate` command, schema migration scripts.

---

## Sprint 4 — Differentiators (P3)

*Features nobody else has. These build on infrastructure we already built.*

### D1. Dream Mode
Agent runs during idle time, replaying past conversations, identifying mistakes, updating its own rules. Not just "sleep cycle diagnostics" — actual offline learning from conversation history. Like memory consolidation during sleep.
**Builds on:** SleepCycle, BehavioralLearning, PredictionJournal, CalibrationLoop
**New:** `improvement/dream-mode.ts` — replay conversations, score past responses against current rules, extract learnings, propose rule updates

### D2. Contradiction Detection
Agent maintains a belief log. When a new response contradicts a past statement, it flags itself. "You said X yesterday but Y today — which is correct?"
**Builds on:** MemorySystem, KnowledgeGraph, TruthBinding
**New:** `safety/contradiction-detector.ts` — belief extraction, belief store, contradiction matching, self-flagging

### D3. Skill Synthesis
Agent watches what tool sequences it uses repeatedly, then proposes a new tool that combines them. Like a macro recorder where the agent writes the code and submits for human approval.
**Builds on:** ToolRegistry, SelfPatching, MultiAgent (ReviewSubagent for code review)
**New:** `improvement/skill-synthesizer.ts` — pattern detection in tool call sequences, code generation, human approval workflow

### D4. Failure Replay
When something goes wrong, agent replays the exact decision sequence that led to failure, annotates where it went sideways, and proposes a prevention rule. Like a flight data recorder.
**Builds on:** SessionManager (decision trace), BehavioralLearning, SelfPatching
**New:** `safety/failure-replay.ts` — decision trace recording, failure detection, replay with annotation, rule proposal

### D5. Confidence Transparency
Every response includes a calibrated confidence score. Not fake "I'm 95% sure" — calibrated against historical Brier scores. Users see when the agent is guessing vs knows.
**Builds on:** CalibrationLoop, IntentPrediction
**New:** `safety/confidence-display.ts` — calibrate confidence against historical accuracy, format for display, attach to responses

### D6. Self-Imposed Constraints
Agent proposes new safety rules based on near-misses. "I almost leaked a secret — I should add a guard for this pattern." Submits for human approval, then permanent.
**Builds on:** CapabilityTiers, TruthBinding, BehavioralLearning, SelfPatching (approval workflow)
**New:** `safety/self-constraints.ts` — near-miss detection, constraint proposal, approval queue, enforcement

### D7. Explainability Layer
Every response includes a traceable chain: intent detected, safety checks run, rules applied, memory recalled, confidence level. For auditing and debugging. Like a black box recorder.
**Builds on:** AgentLoop (already emits stream events), Streaming handler
**New:** `safety/explainability.ts` — decision trace collector, format for audit log, dashboard integration

### D8. Contextual Identity
Agent adapts communication style based on who it's talking to, what channel, time of day, conversation history. Same identity, different register. Like how you talk to your boss vs your friend.
**Builds on:** BehavioralLearning, IntentPrediction, IdentityLoader
**New:** `identity/contextual-style.ts` — style profiles, context detection, adaptive prompt construction

---

## Sprint 5 — New Capabilities (P4)

*Useful features that exist in other frameworks but we should do better.*

### E1. Cost Tracking
Per-conversation token usage, daily/weekly/monthly cost reports, budget alerts.

### E2. Multi-Model Routing
Route different task types to different models. Cheap for simple questions, expensive for complex. Automatic escalation based on confidence.

### E3. Email Channel
IMAP/SMTP integration, draft/review/send workflow, thread awareness.

### E4. Calendar Integration
CalDAV or Google Calendar, "What's on my schedule?" tool, meeting scheduling.

### E5. Webhook Integrations
Incoming webhooks trigger agent actions, outgoing webhooks on events, GitHub/Slack/custom support.

### E6. Voice I/O
Whisper or Web Speech API for voice input, TTS for voice output, voice-first channel.

### E7. Image/Multimodal
Vision models for image understanding, screenshot analysis, OCR for documents.

### E8. A/B Prompt Testing
Compare response quality across prompt variations, statistical significance tracking, auto-promote winning prompts.

---

## Sprint 6 — Quality (P5)

*Hardening for production.*

23. Remove all `any` types from production code
24. Error handling audit — no swallowed errors, proper error types
25. Test coverage for 15 untested modules
26. Multi-user support — session scoping, per-user memory, access control
27. Cross-agent knowledge transfer protocol
28. Undo — reverse agent actions (email retraction, file restore)

---

## What Makes Lodestone Unique

**Already built (no framework has these):**
- Deterministic safety layer (no LLM in policy path)
- Self-improvement loop (prediction → calibration → drift → self-patch)
- Evidence-gated memory promotion
- Capability tiers with sleep-mode restrictions
- Behavioral learning from corrections

**Sprint 4 adds (nobody has these):**
- Dream mode (offline learning from conversation history)
- Contradiction detection (self-flagging when beliefs change)
- Skill synthesis (agent proposes new tools from usage patterns)
- Failure replay (flight data recorder for agent decisions)
- Confidence transparency (calibrated, not fake)
- Self-imposed constraints (agent proposes its own safety rules)
- Explainability layer (full decision trace for every response)
- Contextual identity (adaptive communication style)

These aren't features copied from other frameworks. They're extensions of the self-improving, deterministic-safety foundation that already makes Lodestone different.
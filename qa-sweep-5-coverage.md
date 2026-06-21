# QA Sweep 5: Test Coverage & Documentation Audit

**Date:** 2026-06-21  
**Auditor:** Subagent (QA Sweep 5)  
**Project:** Lodestone — `/Users/flint/.openclaw/workspace/projects/lodestone`

---

## 1. Test Suite Results

### Execution: `npm test`

**Result: ✅ ALL PASSING — 243 tests, 0 failures**

| Test File | Tests | Status |
|-----------|-------|--------|
| `e2e-all-gaps.ts` | 32 | ✅ All pass |
| `e2e-phase3.ts` | 24 | ✅ All pass |
| `e2e-sprint6.ts` | 146 | ✅ All pass |
| `e2e-compounding.ts` | 16 | ✅ All pass |
| `e2e-phase4.ts` | 17 | ✅ All pass |
| `tool-tests.ts` | 8 | ✅ All pass |
| **Total** | **243** | **✅** |

The `npm test` script runs: `e2e-all-gaps.ts && e2e-phase3.ts && e2e-sprint6.ts && e2e-compounding.ts && e2e-phase4.ts && tool-tests.ts`

Note: The README claims "235 tests" but actual count is 243. The README is stale.

---

## 2. Test Coverage Gap Analysis

### 2.1 Source Files (excluding test/ and dist/)

**Total source files:** 120 files in `packages/core/src/` (excluding test/)

### 2.2 Test Files

**18 test files** in `packages/core/src/test/`:
- `e2e-all-gaps.ts` — 32 tests (gaps 1-9)
- `e2e-phase3.ts` — 24 tests (calibration, drift, patch automation, multi-agent)
- `e2e-sprint6.ts` — 146 tests (cost tracker, model router, webhooks, A/B testing, email/voice channels, calendar, vision, file-ops, code-exec, web-search/fetch, config validator, logger, health checker, migrations, onboarding, session persistence, stream handler, plugin system, user manager)
- `e2e-compounding.ts` — 16 tests (memory compounding integration)
- `e2e-phase4.ts` — 17 tests (session cleanup, tool timeout, coordinator tool)
- `tool-tests.ts` — 8 tests (wiki-write, wiki-read, memory-store, memory-recall)
- `e2e-improvement.ts` — 38 tests (not in npm test script)
- `m1-integration.ts` — 15 tests (not in npm test script)
- `dogfood.ts`, `dogfood2.ts`, `dogfood3.ts`, `dogfood4.ts` — integration tests (not counted in npm test)
- `live-chat.ts`, `live-smoke.ts` — live LLM tests (not in npm test script)
- `tui-chat.ts`, `tui-onboarding.ts` — TUI tests (not in npm test script)
- `webchat-test.ts`, `webchat-integration.ts` — webchat tests (not in npm test script)

### 2.3 Tools: 39 Implemented, 16 Tested

**39 tool implementations** in `packages/core/src/tools/impl/`:

| # | Tool | Has Direct Test? | Test File |
|---|------|-----------------|-----------|
| 1 | wiki-resolve | ✅ | dogfood*.ts, m1-integration.ts, live-*.ts, webchat-integration.ts |
| 2 | wiki-write | ✅ | tool-tests.ts |
| 3 | wiki-read | ✅ | tool-tests.ts |
| 4 | memory-store | ✅ | tool-tests.ts |
| 5 | memory-recall | ✅ | tool-tests.ts |
| 6 | smart-retrieve | ✅ | dogfood*.ts, m1-integration.ts, live-*.ts, webchat-integration.ts |
| 7 | decision-log | ✅ | dogfood*.ts, m1-integration.ts, live-*.ts, webchat-integration.ts |
| 8 | resume-state | ✅ | dogfood*.ts, m1-integration.ts, live-*.ts, webchat-integration.ts |
| 9 | watchdog | ✅ | dogfood*.ts, m1-integration.ts, live-*.ts, webchat-integration.ts |
| 10 | business-hours | ✅ | dogfood*.ts, m1-integration.ts, live-*.ts, webchat-integration.ts |
| 11 | web-search | ✅ | e2e-sprint6.ts |
| 12 | web-fetch | ✅ | e2e-sprint6.ts |
| 13 | file-ops | ✅ | e2e-sprint6.ts |
| 14 | code-exec | ✅ | e2e-sprint6.ts |
| 15 | calendar | ✅ | e2e-sprint6.ts |
| 16 | vision | ✅ | e2e-sprint6.ts |
| 17 | voice | ✅ | e2e-sprint6.ts |
| 18 | coordinator | ✅ | e2e-phase4.ts |
| 19 | shell | ❌ | — |
| 20 | http | ❌ | — |
| 21 | process-manager | ❌ | — |
| 22 | diff-patch | ❌ | — |
| 23 | git | ❌ | — |
| 24 | browser | ❌ | — |
| 25 | scheduler | ❌ | — |
| 26 | send-message | ❌ | — |
| 27 | database | ❌ | — |
| 28 | mcp-client | ❌ | — |
| 29 | image-gen | ❌ | — |
| 30 | ocr | ❌ | — |
| 31 | transcribe | ❌ | — |
| 32 | clipboard | ❌ | — |
| 33 | notify | ❌ | — |
| 34 | secrets | ❌ | — |
| 35 | search-engine | ❌ | — |
| 36 | screenshot | ❌ | — |
| 37 | zip | ❌ | — |
| 38 | lsp | ❌ | — |
| 39 | (wiki-search via WikiSearchTool) | ✅ | dogfood*.ts, live-*.ts |

**Coverage: 17/39 tools tested (43.6%)** — 22 tools have NO direct test coverage.

### 2.4 Source Files with No Test Coverage

Major source modules with **no direct test references**:

| Module | File | Notes |
|--------|------|-------|
| Agent loop | `agent-loop.ts` | Core orchestrator, untested |
| Boot | `boot.ts` | Boot sequence |
| Engine | `engine.ts` | Main engine class |
| SDK | `sdk.ts` | Public API |
| Config loader | `config-loader.ts` | Config loading |
| Config watcher | `utils/config-watcher.ts` | Hot-reload config |
| Contextual style | `identity/contextual-style.ts` | Style adaptation |
| Identity loader | `identity/loader.ts` | Identity file loading |
| Dream mode | `improvement/dream-mode.ts` | Not directly tested |
| Drift detector | `improvement/drift-detector.ts` | Tested indirectly via drift-correction |
| Proactive intelligence | `improvement/proactive-intelligence.ts` | No test |
| RBT diagnosis | `improvement/rbt-diagnosis.ts` | No test |
| Skill evolver | `improvement/skill-evolver.ts` | No test |
| Skill synthesizer | `improvement/skill-synthesizer.ts` | No test |
| Sleep cycle | `improvement/sleep-cycle.ts` | No test |
| Knowledge transfer | `memory/knowledge-transfer.ts` | No test |
| Scratch buffer | `memory/scratch-buffer.ts` | No direct test |
| Vector memory | `memory/vector-memory.ts` | No direct test |
| Confidence display | `safety/confidence-display.ts` | No test |
| Contradiction detector | `safety/contradiction-detector.ts` | Indirectly via e2e-compounding |
| Explainability | `safety/explainability.ts` | No test |
| Failure replay | `safety/failure-replay.ts` | No test |
| Self-constraints | `safety/self-constraints.ts` | No direct test |
| Undo system | `safety/undo-system.ts` | No test |
| Dashboard | `dashboard/server.ts`, `dashboard/auth.ts`, `dashboard/log-viewer.ts` | dogfood3/4 test indirectly |
| Channels | `channels/discord.ts`, `channels/telegram.ts`, `channels/webchat.ts` | dogfood3/4 test webchat |
| TUI Chat | `tui-chat/*.ts` (7 files) | tui-chat.ts test exists but not in npm test |
| Onboarding | `onboarding/onboarding.ts` | tui-onboarding.ts test exists but not in npm test |
| CLI | `cli.ts`, `cli/commands/*.ts` | No tests |
| Rate limiter | `llm/rate-limiter.ts` | No test |
| Retry | `llm/retry.ts` | No test |
| LLM provider | `llm/provider.ts` | No direct test |
| 22 tool impls | See table above | No tests |

---

## 3. Test Quality Assessment

### 3.1 `e2e-all-gaps.ts` — 32 Distinct Test Cases

Covers 8 gap modules:
- **Gap 1: Capability Tiers** (5 tests) — auto-approve, sleep blocking, dangerous command detection, tier count
- **Gap 2: Behavioral Learning** (3 tests) — correction detection, rule extraction, prompt formatting
- **Gap 3: Memory Promotion** (2 tests) — claim submission, verification
- **Gap 4: Truth-Binding** (5 tests) — secret blocking, placeholder URL warning, normal text passage, wouldBlock, guard status
- **Gap 5: Intent Prediction** (5 tests) — question/task/correction categories, urgency, heartbeat
- **Gap 7: Quality Gates** (3 tests) — output review, secret blocking, shouldGate
- **Gap 8: Knowledge Graph** (5 tests) — add/retrieve nodes, add edges, neighbors, DOT export, stats
- **Gap 9: Self-Patching** (4 tests) — valid patch, dangerous target blocked, secret blocked, stats

**Quality: Good.** These are functional tests with real assertions, not just smoke tests. They test both happy paths and edge cases (dangerous inputs, missing data).

### 3.2 `tool-tests.ts` — 8 Tests

Tests 4 tools (wiki-write, wiki-read, memory-store, memory-recall):
1. wiki-write: write a wiki page — verifies file written to disk
2. wiki-read: read the wiki page back — verifies content matches
3. wiki-read: non-existent page returns null — error handling
4. memory-store: store a fact — verifies stored data
5. memory-store: empty text fails gracefully — error handling
6. memory-recall: recall stored memories — verifies search works
7. memory-recall: no matches returns empty array — edge case
8. wiki-write: missing slug fails gracefully — error handling

**Quality: Good.** Tests are meaningful — they verify actual behavior (file creation, content matching, error handling), not just "doesn't crash." Each test has real assertions with specific expected values.

### 3.3 Skipped/Disabled Tests

**No skipped tests found.** Searched for `it.skip`, `describe.skip`, `test.skip`, `xit`, `xdescribe` patterns — zero matches in source code.

---

## 4. Documentation Audit

### 4.1 README.md

| Check | Status | Details |
|-------|--------|---------|
| Mentions 39 tools | ❌ | README says "15 built-in tools" in 4 places (lines 59, 254, 261, 371, 465) |
| Mentions glm-5.2:cloud as default model | ✅ | Lines 115, 156, 163, 450 |
| Test count accurate | ❌ | README says "235 tests" (lines 410, 464); actual is 243 |
| CLI commands accurate | ⚠️ | `lodestone tools list` says "15 built-in" but should say 39 |
| Built-in Tools table | ❌ | Lists only 15 tools, missing 24 (shell, http, process-manager, diff-patch, git, browser, scheduler, send-message, database, mcp-client, image-gen, ocr, transcribe, clipboard, notify, secrets, search-engine, screenshot, zip, lsp, wiki-write, wiki-read, memory-store, memory-recall) |
| Architecture diagram | ⚠️ | Shows "Tools (15)" but should show 39 |

### 4.2 `docs/getting-started.md`

| Check | Status | Details |
|-------|--------|---------|
| Up to date | ❌ | Line 198: "Capabilities: 15 tools across 4 tiers" — should be 39 |
| Tool list | ❌ | Line 225: "Your agent comes with 15 tools out of the box" — should be 39 |
| Model reference | ✅ | References `glm-5.2:cloud` correctly |
| Templates | ✅ | Lists 5 templates correctly |
| Config reference | ✅ | Shows current config structure |

### 4.3 JSDoc Coverage on Tool Implementations

All 38 tool implementation files have at least 1 `/**` comment block:

| Tool | JSDoc Count | Tool | JSDoc Count |
|------|------------|------|------------|
| calendar | 13 | vision | 12 |
| code-exec | 6 | secrets | 6 |
| voice | 6 | shell | 5 |
| lsp | 5 | file-ops | 4 |
| http | 3 | git | 2 |
| diff-patch | 2 | web-fetch | 2 |
| wiki-resolve | 2 | process-manager | 2 |
| browser | 1 | business-hours | 1 |
| clipboard | 1 | coordinator | 1 |
| database | 1 | decision-log | 1 |
| image-gen | 1 | mcp-client | 1 |
| memory-recall | 1 | memory-store | 1 |
| notify | 1 | ocr | 1 |
| resume-state | 1 | scheduler | 1 |
| screenshot | 1 | search-engine | 1 |
| send-message | 1 | smart-retrieve | 1 |
| transcribe | 1 | watchdog | 1 |
| web-search | 1 | wiki-read | 1 |
| wiki-write | 1 | zip | 1 |

**JSDoc coverage: 100%** (all 38 files have at least 1 JSDoc block). However, many have only 1 (likely just the file header). Quality varies — `calendar.ts` and `vision.ts` have the most (12-13), while 20+ files have only 1.

### 4.4 CLI Help Text

The README CLI commands section lists:
- `lodestone tools list` — says "List registered tools (15 built-in)" — **WRONG: should say 39**
- Other commands (init, start, status, chat, memory, config, doctor) appear accurate

---

## 5. Stale Code Analysis

### 5.1 TODO / FIXME / HACK / XXX

**1 actionable TODO found:**

| File | Line | Content | Severity |
|------|------|---------|----------|
| `packages/cli/src/commands/status.ts` | 81 | `const isRunning = false; // TODO: check actual process status` | **Medium** — hardcoded false, status command always shows not running |

**2 informational TODO/FIXME references (not actual TODOs):**
- `packages/core/src/improvement/patch-automation.ts` — lines 195, 229, 272-285: These are the patch automation system *scanning* for TODO/FIXME in code. Not actual TODOs — the code itself detects TODOs. **Not a defect.**
- `packages/core/src/improvement/multi-agent.ts` — lines 537-543: Same pattern — code reviewer checks for TODOs. **Not a defect.**

### 5.2 Commented-Out Code

Found ~50+ lines of commented-out code across multiple files. Most notable:

| File | Line | Content | Assessment |
|------|------|---------|------------|
| `safety/truth-binding.ts:590` | `// For now, return a placeholder` | **Concerning** — placeholder return in production code |
| `utils/health-checks.ts:150` | `// returns void. Use eval to bypass the type checker...` | **Hack** — using eval to bypass type checking |
| `tools/impl/resume-state.ts:97` | `// Can't delete from scratch buffer through MemoryAccess interface` | Interface limitation workaround |
| `tools/impl/secrets.ts:137` | `// Corrupted file — return empty rather than throwing` | Defensive design choice (not stale) |
| Various logger.ts, config-validator.ts, agent-loop.ts | Multiple | Comments explaining implementation details | Normal code comments, not stale |

**No significant blocks of dead/commented-out code found.** The comments are mostly explanatory annotations, not disabled code paths.

---

## 6. Summary

### Test Metrics

| Metric | Value |
|--------|-------|
| Total tests in `npm test` | 243 |
| All passing | ✅ Yes |
| Skipped/disabled tests | 0 |
| Tools with tests | 17 / 39 (43.6%) |
| Tools without tests | 22 / 39 (56.4%) |
| Source files without test coverage | ~60+ of 120 |
| Test files not in npm test script | 7 (e2e-improvement, m1-integration, dogfood 1-4, live-*, tui-*, webchat-*) |

### Documentation Issues

| Issue | Location | Fix |
|-------|----------|-----|
| "15 built-in tools" should be "39" | README.md lines 59, 254, 261, 371, 465 | Update all references |
| "235 tests" should be "243" | README.md lines 410, 464 | Update test count |
| "15 tools" in getting-started | docs/getting-started.md lines 198, 225 | Update to 39 |
| Tools table missing 24 tools | README.md line 261+ | Add missing tools to table |
| CLI help shows wrong count | README.md line 254 | Update to 39 |

### Stale Code Issues

| Issue | Location | Severity |
|-------|----------|----------|
| Hardcoded `isRunning = false` with TODO | packages/cli/src/commands/status.ts:81 | Medium |
| Placeholder return in truth-binding | packages/core/src/safety/truth-binding.ts:590 | Medium |
| eval() to bypass type checker | packages/core/src/utils/health-checks.ts:150 | Low (hack) |

### Coverage Priorities (recommended order)

1. **`agent-loop.ts`** — Core orchestrator, highest impact
2. **`engine.ts`** — Main engine class
3. **`tools/impl/shell.ts`** — Commonly used tool, no test
4. **`tools/impl/git.ts`** — Commonly used tool, no test
5. **`tools/impl/browser.ts`** — Complex tool, no test
6. **`tools/impl/http.ts`** — Network tool, no test
7. **`safety/undo-system.ts`** — Safety-critical, no test
8. **`safety/explainability.ts`** — Safety-critical, no test
9. **`safety/self-constraints.ts`** — Safety-critical, no test
10. **`llm/provider.ts`** — LLM integration, no test
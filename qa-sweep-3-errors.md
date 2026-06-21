# QA Sweep 3: Error Handling & Resilience Audit

**Project:** Lodestone  
**Date:** 2026-06-20  
**Auditor:** Automated subagent  

---

## 1. Swallowed Errors (Empty Catch Blocks)

### Summary

There are ~45+ empty catch blocks (`catch {`) across the codebase. Most are intentional best-effort patterns, but several swallow errors that could mask real problems.

### Findings

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 1.1 | `core/src/tools/impl/http.ts:68` | **Medium** | `catch {}` — returns a generic error result but discards the original error. The `err` variable is not captured, so the specific fetch failure (DNS, timeout, connection refused) is lost. Should capture and log the error. |
| 1.2 | `core/src/tools/impl/screenshot.ts:290` | **Low** | `catch {}` — falls through to default method. Intentional fallback, but no logging of which screenshot method failed. |
| 1.3 | `core/src/tools/impl/scheduler.ts:281` | **Medium** | `catch {}` — returns `{ tasks: [] }` on error. A corrupted schedule file or parse error would silently return empty tasks with no diagnostic. Should log the error. |
| 1.4 | `core/src/tools/impl/resume-state.ts:85` | **Medium** | `catch {}` — returns a default state on parse failure. Corrupted state file is silently replaced. Should log a warning so the user knows state was lost. |
| 1.5 | `core/src/tools/impl/secrets.ts:136` | **High** | `catch {}` — returns empty on corrupted secrets file. This silently loses all stored secrets. Should at minimum log that the file was corrupted. |
| 1.6 | `core/src/tools/impl/process-manager.ts:191` | **Low** | `catch {}` — process may have exited between checks. Acceptable race-condition handling. |
| 1.7 | `core/src/tools/impl/lsp.ts:230` | **Medium** | `catch {}` — swallows LSP server start failure. Falls through silently. Should log which language server failed to start. |
| 1.8 | `core/src/migration/migration-system.ts:244,308,331` | **Medium** | Multiple `catch {}` blocks return `0` or `null` on errors reading migration state. Could mask corruption. |
| 1.9 | `core/src/onboarding/onboarding.ts:449` | **Low** | `catch { }` — empty catch on partial save cleanup. Fully empty, no comment. Acceptable (best-effort cleanup). |
| 1.10 | `core/src/channels/manager.ts:246` | **Low** | `catch {}` — channel send failed after retry. Acceptable — nothing more can be done. |
| 1.11 | `core/src/channels/discord.ts:256,282` | **Low** | `catch {}` — non-critical Discord operations. Acceptable with comments present. |
| 1.12 | `core/src/channels/telegram.ts:343,421` | **Low** | `catch {}` — Telegram streaming/edit failures. Acceptable — degrades gracefully. |
| 1.13 | `core/src/agent-loop.ts:100,112,154,301,350,369,387,398,414,563,769,838,887,922,942` | **Low** | 15+ `catch {}` blocks in agent-loop, all marked "Best-effort". These are intentional — plugin hooks, confidence scoring, cost tracking, style adaptation, constraint checks, and wiki writes must never block the main loop. Pattern is correct but means failures are invisible unless logged. **Recommendation:** Ensure each has at least a `this.logger.debug()` call. |

---

## 2. Unhandled Promise Rejections (Missing await)

### Findings

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 2.1 | `core/src/tools/impl/decision-log.ts:105` | **Low** | `.catch(() => {})` — fire-and-forget wiki write. Intentional (non-fatal), but completely silences errors. |
| 2.2 | `core/src/safety/self-constraints.ts:290,464,525,528,550,600` | **Medium** | 6 fire-and-forget `.catch(err => logger.warn(...))` calls for `saveNearMisses()`, `saveProposals()`, `saveConstraints()`. These are async saves that happen inline. If the save fails, data is lost silently (only a warning log). The caller doesn't know the save failed. **Recommendation:** These should either be awaited (blocking but safe) or have a retry mechanism. |
| 2.3 | `core/src/improvement/skill-synthesizer.ts:207,290,326,385,412` | **Medium** | 5 fire-and-forget saves (`saveSequences()`, `savePatterns()`, `saveProposals()`). Same pattern as self-constraints. Skill synthesis data could be lost on save failure. |
| 2.4 | `core/src/channels/manager.ts:74` | **Low** | `channel.start().catch(err => ...)` — fire-and-forget channel start. Wrapped in `Promise.all` above, so this is actually awaited. Not a true fire-and-forget. |
| 2.5 | `core/src/channels/email.ts:265` | **Low** | `this.poll().catch(err => ...)` — fire-and-forget poll in setInterval callback. Acceptable — errors are logged. |
| 2.6 | `core/src/memory/knowledge-transfer.ts:220` | **Medium** | `memory.vector.store(...).catch(err => ...)` — fire-and-forget vector store during knowledge transfer. If the store fails, transferred knowledge is silently lost. Should be awaited. |
| 2.7 | `core/src/tools/impl/screenshot.ts:218` | **Low** | `.catch(() => ...)` — fallback between screenshot methods. Acceptable chained fallback. |
| 2.8 | `core/src/tools/impl/voice.ts:265-266` | **Low** | `.then(text => resolve(...)).catch(() => resolve(stdout.trim()))` — fallback from whisper to stdout. Acceptable graceful degradation. |
| 2.9 | `core/src/memory/memory-system.ts:123` | **Low** | `this.compounding.init().then(() => undefined)` — pushed to `initPromises` array, awaited via `Promise.all`. Not fire-and-forget. |
| 2.10 | `core/src/onboarding/onboarding.ts:448,517` | **Low** | `fs.unlink(...).catch(() => {})` — best-effort cleanup of partial saves. Acceptable. |

---

## 3. Missing Try-Catch Around External Calls

### 3.1 Vector Memory (`vector-memory.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 3.1.1 | `core/src/memory/vector-memory.ts:65` | **High** | `init()` — `await connect(this.config.dbPath)` is NOT wrapped in try-catch. If LanceDB connection fails (corrupted DB, permissions issue), the error propagates unhandled to the caller. Should wrap and throw a descriptive `MemoryError`. |
| 3.1.2 | `core/src/memory/vector-memory.ts:155-161` | **High** | `forget()` — `this.db!.openTable('memories')` and `table.delete()` are NOT wrapped in try-catch. If the table doesn't exist or the delete query fails, an unhandled error propagates. The `recall()` method has try-catch but `forget()` does not. |
| 3.1.3 | `core/src/memory/vector-memory.ts:175-186` | **Medium** | `embedOllama()` — `fetch()` call is NOT wrapped in try-catch. Network errors (connection refused, DNS failure) will throw unhandled. The caller (`store()`) catches some errors but only for schema mismatches, not network failures. |
| 3.1.4 | `core/src/memory/vector-memory.ts:192-209` | **Medium** | `embedOpenAI()` — Same issue as embedOllama. `fetch()` call not wrapped. Network errors propagate unhandled. |

### 3.2 Wiki Store (`wiki-store.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 3.2.1 | `core/src/memory/wiki-store.ts:119` | **Medium** | `write()` — `await writeFile(filePath, fileContent, 'utf-8')` is NOT wrapped in try-catch. Disk full, permission denied, or path issues will throw unhandled. |
| 3.2.2 | `core/src/memory/wiki-store.ts:143-150` | **Medium** | `delete()` — `await unlink(filePath)` is NOT wrapped in try-catch. File not found or permission errors propagate. |
| 3.2.3 | `core/src/memory/wiki-store.ts:238` | **Low** | `loadFile()` — `await readFile(filePath, 'utf-8')` is NOT wrapped in try-catch. Called from `ensureLoaded()` which iterates directories. A single corrupted/unreadable file would crash the entire wiki load. |
| 3.2.4 | `core/src/memory/wiki-store.ts:392` | **Low** | `ensureLoaded()` — `await readdir(categoryDir)` is NOT wrapped. Directory listing failure crashes wiki initialization. |
| 3.2.5 | `core/src/memory/wiki-store.ts:158-166` | **Low** | `write()` callbacks — properly wrapped in try-catch. Good pattern. |

### 3.3 HTTP Tool (`http.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 3.3.1 | `core/src/tools/impl/http.ts:55-90` | **Low** | The main `execute()` is properly wrapped in try-catch. AbortController timeout is correctly implemented. Error handling is good — returns structured error result. |
| 3.3.2 | `core/src/tools/impl/http.ts:68` | **Medium** | The `catch` block at line 68 (for the HTTP request) discards the error variable — `catch {` instead of `catch (err)`. The error is not logged. Should capture and log for diagnostics. |

### 3.4 Web Fetch (`web-fetch.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 3.4.1 | `core/src/tools/impl/web-fetch.ts:46-75` | **Low** | Properly wrapped in try-catch. No timeout via AbortController, but the tool-level timeout (20s) provides a fallback. Could benefit from explicit AbortController for cleaner cancellation. |

### 3.5 Web Search (`web-search.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 3.5.1 | `core/src/tools/impl/web-search.ts:43-60` | **Low** | Properly wrapped in try-catch. No explicit timeout on fetch calls — relies on tool-level timeout (15s). Acceptable. |

---

## 4. Infinite Loops / Recursive Calls Without Termination

### Findings

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 4.1 | `core/src/tools/impl/lsp.ts:551` | **None** | `while (true)` — properly bounded with `break` on incomplete message (`headerEnd === -1`) and insufficient buffer length. Correct LSP message parsing pattern. |
| 4.2 | `core/src/tools/impl/screenshot.ts:269` | **None** | `while (offset < buffer.length - 1)` — bounded by buffer length. Correct. |
| 4.3 | `core/src/cli.ts:289` | **None** | `while (Date.now() - start < 10_000)` — bounded by 10-second timeout. Correct. |
| 4.4 | No recursive call patterns found that lack termination. | — | All `recursive: true` references are `mkdirSync`/`rmSync` options, not code recursion. |

**No infinite loop risks found.**

---

## 5. Resource Leaks

### 5.1 Socket.IO / WebChat (`webchat.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 5.1.1 | `core/src/channels/webchat.ts:155` | **Low** | `stop()` properly calls `io.disconnectSockets(true)` and `httpServer.close()`. Session map is cleared. Good cleanup. |
| 5.1.2 | `core/src/channels/webchat.ts:120` | **Low** | On `disconnect` event, `sessionMap.delete(socket.id)` is called. Stale socket entries for persistent sessions are cleaned on reconnection (line 115-118). Good. |
| 5.1.3 | `core/src/channels/webchat.ts` | **Low** | No explicit error handler on the Socket.IO server itself. If the server encounters an unexpected error, it may not be logged. Consider adding `io.on('error', ...)`. |

### 5.2 Email Channel (`email.ts`)

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 5.2.1 | `core/src/channels/email.ts:225-245` | **Low** | `stop()` properly clears poll timer, disconnects IMAP, and closes SMTP. Good cleanup pattern. |
| 5.2.2 | `core/src/channels/email.ts:136-146` | **Low** | IMAP/SMTP close wrapped in `catch {}` — best-effort close. Acceptable. |
| 5.2.3 | `core/src/channels/email.ts:413-447` | **Medium** | `fetchNewMessages()` opens a mailbox but doesn't close it. IMAP box is left open after fetch. Should call `imap.closeBox()` after fetching. If the poll runs again while a box is still open, it may fail or cause resource leak. |

### 5.3 File Handles

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 5.3.1 | `core/src/tools/impl/code-exec.ts:133` | **None** | Temp dir cleaned with `rmSync(..., { recursive: true })` in finally-like catch. Best-effort. |
| 5.3.2 | `core/src/tools/impl/transcribe.ts:308` | **None** | Same pattern — temp dir cleanup. Best-effort. |
| 5.3.3 | `core/src/tools/impl/ocr.ts:258` | **None** | Same pattern. Best-effort. |

**No significant resource leaks found.** The email IMAP box issue (5.2.3) is the only actionable item.

---

## 6. Timeout Handling

### 6.1 ToolDefinition Timeout Field

The `ToolDefinition` interface includes an optional `timeout?: number` field (line 38 of `definitions.ts`). The tool executor enforces this with `Promise.race()` against a setTimeout (lines 170-176). Default timeout is 30 seconds if not specified.

### 6.2 Tools Missing Explicit Timeout

| # | File | Severity | Description |
|---|------|----------|-------------|
| 6.2.1 | `core/src/tools/impl/business-hours.ts` | **Low** | No `timeout` in definition. Falls back to 30s default. Acceptable — this is a quick file read. |
| 6.2.2 | `core/src/tools/impl/coordinator.ts` | **Low** | No `timeout`. Falls back to 30s default. Should be lower (5-10s) for a coordination tool. |
| 6.2.3 | `core/src/tools/impl/decision-log.ts` | **Low** | No `timeout`. Falls back to 30s default. Acceptable — file I/O is fast. |
| 6.2.4 | `core/src/tools/impl/memory-recall.ts` | **Medium** | No `timeout`. Calls vector memory recall which involves embedding + LanceDB query. Could hang if LanceDB is unresponsive. Should have explicit timeout (15s). |
| 6.2.5 | `core/src/tools/impl/memory-store.ts` | **Medium** | No `timeout`. Calls vector memory store which involves embedding + LanceDB write. Same risk as memory-recall. Should have explicit timeout (15s). |
| 6.2.6 | `core/src/tools/impl/resume-state.ts` | **Low** | No `timeout`. File read/write — fast. 30s default is generous but safe. |
| 6.2.7 | `core/src/tools/impl/smart-retrieve.ts` | **Medium** | No `timeout`. Searches wiki + vector memory. Could be slow with large datasets. Should have explicit timeout (15s). |
| 6.2.8 | `core/src/tools/impl/watchdog.ts` | **Low** | No `timeout`. File I/O — fast. |
| 6.2.9 | `core/src/tools/impl/wiki-read.ts` | **Low** | No `timeout`. File read — fast. |
| 6.2.10 | `core/src/tools/impl/wiki-resolve.ts` | **Low** | No `timeout`. File read — fast. |
| 6.2.11 | `core/src/tools/impl/wiki-write.ts` | **Low** | No `timeout`. File write + index rebuild — could be slow with many pages. 30s default is safe. |

### 6.3 Tools With Explicit Timeout (verified good)

| Tool | Timeout | Internal Enforcement |
|------|---------|----------------------|
| `http.ts` | 30s | AbortController on fetch (15s default param) |
| `shell.ts` | 60s | `exec` timeout param (30s default) |
| `search-engine.ts` | 15s | None (relies on tool-level) |
| `web-search.ts` | 15s | None (relies on tool-level) |
| `web-fetch.ts` | 20s | None (relies on tool-level) — **could benefit from AbortController** |
| `code-exec.ts` | 30s | `spawn` timeout |
| `image-gen.ts` | 60s | `execFile` timeout (55s) |
| `transcribe.ts` | 120s | `execFile` timeout (110s) |
| `screenshot.ts` | 10s | `execFile` timeout (8s) |
| `clipboard.ts` | 5s | `execFile` timeout (4s) |
| `ocr.ts` | 30s | `execFile` timeout (25s) |
| `git.ts` | 30s | `exec` timeout (25s) |
| `voice.ts` | 30s | Process timeout |
| `lsp.ts` | 30s | None (relies on tool-level) |
| `zip.ts` | 60s | `execFile` timeout (55s) |
| `notify.ts` | 10s | `execFile` timeout (8s) |
| `file-ops.ts` | 10s | None (relies on tool-level) |
| `diff-patch.ts` | 10s | None (relies on tool-level) |
| `secrets.ts` | 5s | None (relies on tool-level) |
| `calendar.ts` | 15s | None (relies on tool-level) |
| `browser.ts` | 30s | None (relies on tool-level) |
| `database.ts` | 15s | None (relies on tool-level) |
| `mcp-client.ts` | 30s | None (relies on tool-level) |
| `send-message.ts` | 15s | None (relies on tool-level) |
| `scheduler.ts` | 10s | None (relies on tool-level) |
| `process-manager.ts` | 10s | None (relies on tool-level) |
| `vision.ts` | 30s | None (relies on tool-level) |

### 6.4 Web Fetch — Missing AbortController

| # | File:Line | Severity | Description |
|---|-----------|----------|-------------|
| 6.4.1 | `core/src/tools/impl/web-fetch.ts:49` | **Medium** | `fetch(url, { redirect: 'follow' })` has no `signal` / AbortController. If the remote server is slow but doesn't drop the connection, the fetch could hang until the tool-level timeout kills it via `Promise.race`. However, the underlying fetch won't be cancelled — it will continue consuming resources until it completes or the process exits. **Recommendation:** Add `AbortController` like `http.ts` does. |

---

## 7. Summary

### Critical (0)
None found.

### High (3)
1. **`vector-memory.ts:65`** — `init()` LanceDB connect not wrapped in try-catch. Unhandled connection failure.
2. **`vector-memory.ts:155-161`** — `forget()` LanceDB openTable + delete not wrapped in try-catch. Unhandled table operation failure.
3. **`secrets.ts:136`** — Corrupted secrets file silently returns empty. All secrets lost with no warning.

### Medium (12)
1. **`http.ts:68`** — Error variable discarded in catch block, no logging.
2. **`scheduler.ts:281`** — Schedule parse error silently returns empty tasks.
3. **`resume-state.ts:85`** — State parse error silently returns default state.
4. **`lsp.ts:230`** — LSP server start failure silently swallowed.
5. **`migration-system.ts:244,308,331`** — Migration state read errors silently return defaults.
6. **`self-constraints.ts` (6 occurrences)** — Fire-and-forget saves lose data on failure without caller awareness.
7. **`skill-synthesizer.ts` (5 occurrences)** — Fire-and-forget saves lose data on failure.
8. **`knowledge-transfer.ts:220`** — Fire-and-forget vector store during knowledge transfer.
9. **`vector-memory.ts:175-209`** — embedOllama/embedOpenAI fetch calls not wrapped in try-catch.
10. **`wiki-store.ts:119,143`** — writeFile/unlink not wrapped in try-catch.
11. **`email.ts:413-447`** — IMAP box not closed after fetch; potential resource leak.
12. **`web-fetch.ts:49`** — No AbortController; fetch continues consuming resources after tool timeout.
13. **memory-recall.ts / memory-store.ts / smart-retrieve.ts** — No explicit timeout; rely on 30s default.

### Low (15+)
- Numerous best-effort `catch {}` blocks in CLI commands (status, doctor, memory, config) — acceptable for diagnostic commands.
- Agent-loop best-effort catches (15+) — intentional, but should log at debug level.
- Channel disconnect/retry catches — acceptable graceful degradation.
- Fire-and-forget cleanup (unlink, rmSync) — acceptable best-effort.

### Recommendations

1. **Wrap all LanceDB calls in try-catch** in `vector-memory.ts` — `init()`, `forget()`, embedding fetch calls. Throw descriptive `MemoryError` on failure.
2. **Log silently swallowed errors** — every `catch {}` should at minimum call `this.logger.debug()` or `console.warn()`. The agent-loop best-effort blocks are the highest volume offender.
3. **Add AbortController to `web-fetch.ts`** — same pattern as `http.ts`.
4. **Close IMAP box after fetch** in `email.ts` — call `imap.closeBox()` in the fetch completion handler.
5. **Add explicit timeouts to memory tools** — `memory-recall.ts`, `memory-store.ts`, `smart-retrieve.ts` should have `timeout: 15000`.
6. **Log on corrupted secrets file** in `secrets.ts:136` — at minimum warn the user that secrets were lost.
7. **Await fire-and-forget saves** in `self-constraints.ts` and `skill-synthesizer.ts` — or add a retry mechanism. Data loss is currently invisible.
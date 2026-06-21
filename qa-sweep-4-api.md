# QA Sweep 4: API Consistency & Interface Audit

**Date:** 2026-06-20  
**Auditor:** Automated subagent  
**Scope:** Tool interface, naming consistency, registration, config schema, CLI commands, templates

---

## 1. Tool Interface Audit (`definitions.ts`)

### ToolDefinition Interface
- ✅ All required fields are clearly marked with JSDoc comments
- ✅ `id`, `name`, `description`, `parameters`, `sideEffects`, `requiresApproval` are all present
- ✅ Optional fields (`timeout`) are marked with `?`
- ✅ `ToolParameter` sub-interface is well-defined with `items` for arrays and `properties` for objects

### ToolContext
- ✅ Well-defined with `sessionId`, `workspaceRoot`, `identity`, `memory`, `engine?`, `log`
- ✅ `AgentIdentity` interface includes all needed identity fields (`name`, `soul`, `rules`, `heartbeat`, `user`)
- ✅ `MemoryAccess` interface provides all operations tools need: `store`, `storeFact`, `recall`, `wikiRead`, `wikiWrite`, `wikiSearch`, `scratchGet`, `scratchSet`
- ✅ `ToolLogger` has standard `info`/`warn`/`error` levels

### ToolResult
- ✅ Consistent structure: `success`, `data`, `summary`, `error?`, `durationMs`, `includeInContext`
- ✅ All 39 tool implementations return `ToolResult` from their `execute()` methods

### Issues Found

| # | Severity | Issue |
|---|----------|-------|
| 1.1 | **Low** | `ToolContext.engine` is typed as `any` — should be `LodestoneEngine` (or a minimal interface subset to avoid circular deps). JSDoc says "for coordinator, safety, improvement systems" but no type enforcement. |
| 1.2 | **Low** | `MemoryAccess` interface has `store` and `storeFact` — `store` takes a raw key/value while `storeFact` does compounding. The distinction is unclear from JSDoc alone. Not a bug, but could confuse tool authors. |
| 1.3 | **Info** | `ToolResult.includeInContext` is always `true` in error paths and `true` by default in success paths. No tool ever sets it to `false`. This field is effectively unused — consider whether it's needed. |

---

## 2. Tool Naming Consistency

### Tool IDs (kebab-case check)
All 39 tool IDs are kebab-case. ✅

### Tool Display Names
All 39 display names use Title Case or descriptive names. ✅

### ID → Name Mapping (complete)

| ID | Display Name | File |
|----|-------------|------|
| `archive` | Archive | zip.ts |
| `browser` | Browser | browser.ts |
| `business-hours` | Business Hours | business-hours.ts |
| `calendar` | Calendar | calendar.ts |
| `clipboard` | Clipboard | clipboard.ts |
| `code-exec` | Code Execution | code-exec.ts |
| `coordinator` | Coordinator | coordinator.ts |
| `database` | Database | database.ts |
| `decision-log` | Decision Log | decision-log.ts |
| `diff-patch` | Diff Patch | diff-patch.ts |
| `file-ops` | File Operations | file-ops.ts |
| `git` | Git Operations | git.ts |
| `http` | HTTP Request | http.ts |
| `image-gen` | Image Generation | image-gen.ts |
| `lsp` | LSP Bridge | lsp.ts |
| `mcp-client` | MCP Client | mcp-client.ts |
| `memory-recall` | Memory Recall | memory-recall.ts |
| `memory-store` | Memory Store | memory-store.ts |
| `notify` | System Notification | notify.ts |
| `ocr` | OCR / Text Extraction | ocr.ts |
| `process-manager` | Process Manager | process-manager.ts |
| `resume-state` | Resume State | resume-state.ts |
| `scheduler` | Scheduler | scheduler.ts |
| `screenshot` | Screenshot | screenshot.ts |
| `search-engine` | Search Engine | search-engine.ts |
| `secrets` | Secrets | secrets.ts |
| `send-message` | Send Message | send-message.ts |
| `shell` | Shell Execution | shell.ts |
| `smart-retrieve` | Smart Retrieve | smart-retrieve.ts |
| `transcribe` | Audio/Video Transcription | transcribe.ts |
| `vision` | Vision / Multimodal | vision.ts |
| `voice` | Voice I/O | voice.ts |
| `watchdog` | Watchdog | watchdog.ts |
| `web-fetch` | Web Fetch | web-fetch.ts |
| `web-search` | Web Search | web-search.ts |
| `wiki-read` | Wiki Read | wiki-read.ts |
| `wiki-resolve` | Wiki Resolve | wiki-resolve.ts |
| `wiki-search` | Wiki Search | wiki-resolve.ts |
| `wiki-write` | Wiki Write | wiki-write.ts |

### Issues Found

| # | Severity | Issue |
|---|----------|-------|
| 2.1 | **Medium** | **File name vs ID mismatch:** `zip.ts` exports `ArchiveTool` with ID `archive`. The file is named `zip.ts` but the tool ID is `archive`. Import in `register-builtin.ts` uses `ArchiveTool` from `./impl/zip.js`. Not a bug but confusing — file should be renamed to `archive.ts` or ID changed to `zip`. |
| 2.2 | **Medium** | **Two tools in one file:** `wiki-resolve.ts` exports both `WikiResolveTool` (id: `wiki-resolve`) AND `WikiSearchTool` (id: `wiki-search`). All other tools are one-per-file. This breaks the convention and makes file discovery harder. |
| 2.3 | **Low** | **Display name inconsistency:** Most names are short (`Browser`, `Calendar`, `Git`), but some are verbose (`Audio/Video Transcription`, `Vision / Multimodal`, `OCR / Text Extraction`, `System Notification`, `Shell Execution`, `File Operations`, `Git Operations`, `Code Execution`, `HTTP Request`, `Image Generation`, `Process Manager`, `Memory Recall`, `Memory Store`, `Smart Retrieve`, `Diff Patch`, `Send Message`, `Search Engine`, `Wiki Resolve`). No standard — some include the domain qualifier, others don't. |
| 2.4 | **Low** | **sideEffects for wiki-write is `false`:** `WikiWriteTool` has `sideEffects: false` but it writes to the wiki. This is semantically incorrect — writing is a side effect. |

---

## 3. Registration Audit (`register-builtin.ts`)

### Count Verification
- **Imports:** 39 tool imports + 1 engine type import = 40 total imports ✅
- **Registrations:** 39 `engine.registerTool(new ...Tool())` calls ✅
- **Unique tool IDs:** 39 (no duplicates) ✅
- **Import paths:** All use `./impl/{name}.js` pattern ✅

### Issues Found

| # | Severity | Issue |
|---|----------|-------|
| 3.1 | **Low** | **Hardcoded configuration in registrations:** `WebSearchTool` is registered with `{ provider: 'searxng', searxngUrl: 'http://localhost:8888' }` — this should come from config, not be hardcoded. Same for `CalendarTool({ provider: 'caldav' })`. |
| 3.2 | **Info** | The comment says "39 built-in tools" and the count matches exactly. Good. |

---

## 4. Config Schema Consistency

### Methodology
Compared `lodestone.config.yaml` (example config), `config-loader.ts` (loader), `config-validator.ts` (schema), and `engine.ts` (LodestoneConfig interface) for field coverage.

### Config Field Usage Map

| YAML Field | Loader Reads? | Schema Validates? | Engine Uses? | Verdict |
|------------|---------------|-------------------|-------------|---------|
| `workspace.root` | ✅ | ✅ | ✅ | OK |
| `identity.dir` | ✅ | ✅ | ✅ | OK |
| `llm.default.type` | ✅ | ✅ | ✅ | OK |
| `llm.default.model` | ✅ | ✅ | ✅ | OK |
| `llm.default.baseUrl` | ✅ | ✅ | ✅ | OK |
| `llm.default.apiKey` | ✅ | ✅ | ✅ | OK |
| `llm.default.contextWindow` | ✅ | ✅ | ✅ | OK |
| `llm.default.maxTokens` | ✅ | ✅ | ✅ | OK |
| `llm.default.temperature` | ❌ | ✅ | ❌ | **Orphaned in schema** |
| `llm.routes` | ✅ | ✅ | ✅ | OK |
| `memory.wiki.path` | ✅ | ✅ | ✅ | OK |
| `memory.vectorDb.path` | ✅ | ✅ | ✅ | OK |
| `memory.vectorDb.embedding.provider` | ✅ | ✅ | ✅ | OK |
| `memory.vectorDb.embedding.model` | ✅ | ✅ | ✅ | OK |
| `memory.vectorDb.embedding.dimensions` | ✅ | ✅ | ✅ | OK |
| `memory.vectorDb.autoCapture` | ✅ | ✅ | ✅ | OK |
| `memory.vectorDb.autoRecall` | ❌ loader | ✅ schema | ✅ engine | **Loader gap** |
| `memory.scratch.path` | ❌ | ✅ | ✅ (engine uses hardcoded `data/scratch.json`) | **Orphaned in config** |
| `session.compactionThreshold` | ✅ | ✅ | ✅ | OK |
| `session.keepRecentCount` | ❌ loader | ✅ schema | ✅ session/manager.ts | **Loader gap** |
| `session.maxEntries` | ❌ loader | ✅ schema | ❌ engine | **Schema-only** |
| `session.pruneAfter` | ❌ loader | ✅ schema | ❌ engine | **Schema-only** |
| `scheduler.maxConcurrent` | ✅ | ✅ | ✅ | OK |
| `dashboard.port` | ✅ | ✅ | ✅ | OK |
| `dashboard.host` | ✅ | ✅ | ✅ | OK |
| `dashboard.dashboardDir` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `dashboard.apiToken` | ✅ | ❌ schema (`authToken` in schema) | ✅ | **Name mismatch** |
| `dashboard.corsOrigin` | ✅ | ❌ schema (`corsOrigins` in schema) | ✅ | **Name mismatch** |
| `channels.*` | ✅ | ✅ | ✅ | OK |
| `proactive.*` | ✅ | ✅ | ✅ | OK |
| `logging.level` | ❌ loader | ✅ schema | ❌ LodestoneConfig | **Not in LodestoneConfig** |
| `logging.file` | ❌ loader | ✅ schema | ❌ LodestoneConfig | **Not in LodestoneConfig** |
| `logging.format` | ❌ loader | ✅ schema | ❌ LodestoneConfig | **Not in LodestoneConfig** |
| `safety.*` | ✅ | ✅ | ✅ | OK |
| `costTracking` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `modelRouting` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `webhooks` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `abTesting` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `email` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `calendar` | ✅ | ❌ schema | ✅ | **Schema gap** |
| `auth` | ✅ | ❌ schema | ✅ | **Schema gap** |

### Issues Found

| # | Severity | Issue |
|---|----------|-------|
| 4.1 | **High** | **`logging` section not in `LodestoneConfig` interface:** The config schema validates `logging.level`, `logging.file`, `logging.format`, and templates define these fields. But `config-loader.ts` never reads them, and `LodestoneConfig` has no `logging` field. The CLI (`cli.ts:540`) reads `config.logging?.file` directly from the raw YAML, bypassing the typed config. **Logging config is untyped and unloaded.** |
| 4.2 | **High** | **Dashboard field name mismatches:** Config YAML and loader use `dashboard.apiToken` and `dashboard.corsOrigin`, but the schema in `config-validator.ts` defines `authToken` and `corsOrigins`. This means validation will warn about unknown fields that are actually correct. |
| 4.3 | **Medium** | **`temperature` in schema but never loaded:** `config-validator.ts` defines `temperature` (0-2, default 0.7) under `llm.default`, but `config-loader.ts` never reads it and `LodestoneConfig.llm.default` (ProviderConfig) may not include it. Temperature is hardcoded in various places (0.7, 0.9). |
| 4.4 | **Medium** | **`session.keepRecentCount` / `maxEntries` / `pruneAfter` not loaded by config-loader:** The schema validates these, templates define them, `session/manager.ts` uses `keepRecentCount`, but `config-loader.ts` doesn't pass them through to `LodestoneConfig`. They fall back to hardcoded defaults in `session/manager.ts` (10, 200, 7d). |
| 4.5 | **Medium** | **`memory.scratch.path` not loaded:** Templates define `memory.scratch.path` but config-loader doesn't read it. Engine hardcodes `join(config.workspaceRoot, 'data/scratch.json')`. The YAML config field is orphaned. |
| 4.6 | **Medium** | **Six config sections missing from schema:** `costTracking`, `modelRouting`, `webhooks`, `abTesting`, `email`, `calendar`, and `auth` are in `LodestoneConfig` and used by the engine, but `lodestoneSchema` in `config-validator.ts` doesn't define them. They pass validation silently as "unknown fields" (generating warnings). |
| 4.7 | **Medium** | **`memory.vectorDb.autoRecall` not loaded by config-loader:** The engine's `MemorySystem` config includes `autoRecall`, the schema validates it, but config-loader never reads it from YAML. It falls back to `true` in `vector-memory.ts`. |
| 4.8 | **Low** | **`maxConcurrentTools` default inconsistency:** Schema default is 5, but config-loader uses `|| 4`. Engine doesn't use `maxConcurrentTools` from config at all (it's not wired to any execution limiter). |
| 4.9 | **Low** | **`dashboard.port` default mismatch:** Schema says default 4400, config-loader uses `|| 3002`, example YAML uses 3002. Three different defaults. |
| 4.10 | **Low** | **`contextWindow` default mismatch:** Schema says 202752, config-loader uses `|| 128000`, all templates use 128000. Schema is wrong. |

---

## 5. CLI Commands Consistency

### Commands Found (9 total)
1. `lodestone init` — Workspace setup wizard
2. `lodestone start` — Boot the engine
3. `lodestone status` — Show engine status
4. `lodestone chat` — Start TUI chat
5. `lodestone tools list` — List registered tools
6. `lodestone memory stats` — Show memory statistics
7. `lodestone config show` — Display current config
8. `lodestone config set` — Update a config value
9. `lodestone doctor` — Health checks and diagnostics
10. `lodestone lint` — Lint wiki

### Issues Found

| # | Severity | Issue |
|---|----------|-------|
| 5.1 | **Medium** | **`status.ts` hardcodes tool list:** Instead of importing `registerBuiltinTools` and listing actual tools, `status.ts` hardcodes a 39-element array of tool names. If a tool is added/removed/renamed, this list will be stale. Should use the same registration mechanism as `tools.ts`. |
| 5.2 | **Medium** | **`status.ts` hardcodes job names:** `['sensorium', 'sleep-cycle', 'drift-detection']` is hardcoded. Should be queried from the scheduler. |
| 5.3 | **Low** | **`config set` doesn't validate:** It writes YAML directly without running `ConfigValidator`. Users can set invalid values that won't be caught until next startup. |
| 5.4 | **Low** | **`memory.ts` only has `stats` subcommand:** The CLI header mentions `lodestone memory stats` but there's no `memory search`, `memory recall`, or `memory clear` — less useful than it could be. Not a bug, just a gap. |
| 5.5 | **Low** | **`chat.ts` hardcodes TUI path:** `resolve(__dirname, '../../../core/dist/test/tui-chat.js')` — pointing at a `test/` directory in `dist/` for a production command is fragile. |
| 5.6 | **Info** | All commands have `.description()` help text ✅ |
| 5.7 | **Info** | All commands handle errors with try/catch and `process.exit(1)` ✅ |
| 5.8 | **Info** | All commands have consistent `-c, --config <path>` and `-w, --workspace <path>` options (where applicable) ✅ |
| 5.9 | **Info** | Error messages are consistent: `chalk.red('Error: ...')` pattern used everywhere ✅ |

---

## 6. Template Files Audit

### Templates Found (5)
- `templates/general/` — General purpose agent
- `templates/developer/` — Software engineering agent
- `templates/business/` — Business operations agent
- `templates/creative/` — Creative/writer agent
- `templates/researcher/` — Research agent

### Each template contains:
- ✅ `IDENTITY.md` — With `{{name}}` and `{{date}}` placeholders
- ✅ `SOUL.md` — With template-specific persona
- ✅ `RULES.md`
- ✅ `USER.md`
- ✅ `HEARTBEAT.md`
- ✅ `AGENTS.md`
- ✅ `lodestone.config.yaml` — With template-specific settings
- ✅ `memory/` directory

### Template Config Issues

| # | Severity | Issue |
|---|----------|-------|
| 6.1 | **Medium** | **All templates use `memory.vectorDb` key but root `lodestone.config.yaml` uses `memory.vector`:** The example config at project root has `memory: { vector: { path: ... } }` but all templates have `memory: { vectorDb: { path: ... } }`. The config-loader reads `config.memory?.vectorDb?.path` — so the root config file is **wrong** (uses `vector` instead of `vectorDb`). |
| 6.2 | **Low** | **Templates define `logging.file` but it's never loaded** (see issue 4.1). Templates set `logging: { level: info, file: ./workspace/data/logs/lodestone.log }` but this is silently ignored. |
| 6.3 | **Low** | **Templates define `session.keepRecentCount` and `maxEntries` but these aren't loaded** (see issue 4.4). The template-specific values (20, 25, 30, etc.) are silently ignored and the default 10/200 is used. |
| 6.4 | **Low** | **`general` template has extra fields:** Includes `pruneAfter: 7d`, `proactive.rbt`, `proactive.wikiLint` — not all of these are read by config-loader. `researcher`, `business`, `creative`, `developer` templates are missing `rbt` and `wikiLint` sections that `general` has. |
| 6.5 | **Info** | All templates have required config fields: `llm.default.type`, `llm.default.model`, `llm.default.baseUrl`, `memory.vectorDb.path`, `memory.wiki.path`, `identity.dir`, `session.compactionThreshold`, `scheduler.maxConcurrent` ✅ |
| 6.6 | **Info** | All identity files have `{{name}}` and `{{date}}` placeholders for the init wizard ✅ |

---

## 7. Summary

### Critical Issues (should fix before release)
1. **Config field name mismatch:** Root `lodestone.config.yaml` uses `memory.vector` but everything else uses `memory.vectorDb` (4.1/6.1)
2. **Dashboard config field name mismatch:** Schema says `authToken`/`corsOrigins`, config-loader/YAML use `apiToken`/`corsOrigin` (4.2)
3. **`logging` config section is completely untyped** — defined in schema and templates but not in `LodestoneConfig` or config-loader (4.1)

### Medium Issues (should fix soon)
4. `temperature`, `session.keepRecentCount`, `session.maxEntries`, `session.pruneAfter`, `memory.scratch.path`, `memory.vectorDb.autoRecall` — all defined in schema/templates but not loaded by config-loader (4.3-4.7)
5. Six config sections (`costTracking`, `modelRouting`, `webhooks`, `abTesting`, `email`, `auth`) missing from schema validator (4.6)
6. `status.ts` hardcodes tool list and job names instead of querying engine (5.1, 5.2)
7. Two tools in one file (`wiki-resolve.ts` has both WikiResolveTool and WikiSearchTool) (2.2)
8. File name `zip.ts` vs ID `archive` mismatch (2.1)

### Low Issues (nice to fix)
9. `contextWindow` default mismatch: schema 202752 vs loader/templates 128000 (4.10)
10. `dashboard.port` default mismatch: schema 4400 vs loader 3002 (4.9)
11. `maxConcurrentTools` schema default 5 vs loader 4, and not wired to engine (4.8)
12. `WikiWriteTool.sideEffects` is `false` but should be `true` (2.4)
13. `config set` doesn't validate before writing (5.3)
14. Display name inconsistency across tools (2.3)

### Statistics
- **39 tools** registered, all unique, all kebab-case IDs ✅
- **39 tool implementations** across **38 files** (wiki-resolve.ts has 2)
- **0 naming collisions** ✅
- **9 CLI commands** with help text and error handling ✅
- **5 templates** with identity files and config ✅
- **3 critical issues**, **8 medium issues**, **6 low issues** found
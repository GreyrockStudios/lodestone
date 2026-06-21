# QA Sweep 2: Security & Secrets Audit

**Date:** 2026-06-20  
**Auditor:** Flint (subagent)  
**Project:** Lodestone  
**Scope:** Hardcoded secrets, .gitignore coverage, secrets tool encryption, SQL injection, command injection, config secret logging  

---

## Summary

Overall security posture is **good**. The secrets tool uses proper AES-256-GCM encryption with random IVs. API keys are loaded from environment variables, not hardcoded. The database tool uses parameterized queries for most operations. No secrets are logged in config loading.

**Findings: 9** — 1 high, 4 medium, 4 low  

---

## Findings

### 1. SQL Injection in SQLite `PRAGMA table_info` — HIGH

**File:** `packages/core/src/tools/impl/database.ts:158`  
**Severity:** HIGH  
**Code:**
```ts
const stmt = db.prepare(`PRAGMA table_info(${table})`);
```

The `table` parameter is interpolated directly into the SQL string without parameterization or sanitization. While `PRAGMA table_info` doesn't accept bound parameters in SQLite, the table name comes from user input (`params.table`) and could contain malicious SQL (e.g., `; DROP TABLE x; --`).

**Recommended fix:** Validate the table name against a whitelist or escape it:
```ts
// Validate table name is alphanumeric + underscore
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
  return { success: false, ... error: 'Invalid table name' };
}
const stmt = db.prepare(`PRAGMA table_info(${table})`);
```

### 2. Weak Fallback Encryption Key — MEDIUM

**File:** `packages/core/src/tools/impl/secrets.ts:81,87-91`  
**Severity:** MEDIUM  
**Code:**
```ts
private keyDerivationSalt = 'lodestone-secrets-v1';  // hardcoded salt
// ...
const user = userInfo().username || 'unknown';
const host = hostname() || 'localhost';
return scryptSync(`${host}:${user}`, this.keyDerivationSalt, this.keyLen);
```

When `LODESTONE_SECRET_KEY` is not set, the encryption key is derived from `hostname:username` with a hardcoded salt. This is predictable — anyone knowing the machine's hostname and username can derive the same key. The scrypt KDF is strong but the input entropy is very low.

**Recommended fix:** 
- Generate a random key on first run and store it in a file with `0o600` permissions if no env key is provided
- Warn the user loudly when falling back to machine identity
- Document the `LODESTONE_SECRET_KEY` env var as recommended

### 3. `.gitignore` Missing Common Secret Patterns — MEDIUM

**File:** `.gitignore`  
**Severity:** MEDIUM  

Current `.gitignore` covers `.env` and `.env.local` but is missing:
- `.env*` (glob pattern — currently only matches `.env` and `.env.local` exactly, missing `.env.production`, `.env.staging`, etc.)
- `secrets*` / `*.enc` — encrypted secrets file (`data/secrets.enc.json`) is not explicitly ignored
- `*.key` — private key files
- `*.pem` — certificate/key files  
- `lancedb/` — vector database directory not explicitly ignored (covered by `/data/` but not at workspace level)

**Current:**
```gitignore
.env
.env.local
```

**Recommended:**
```gitignore
# Environment
.env
.env.*
!.env.example

# Secrets & keys
*.key
*.pem
secrets.*
*.enc.json

# Vector DB
lancedb/
```

Note: `data/secrets.enc.json` is covered by the `/data/` entry in `.gitignore`, but an explicit `*.enc.json` pattern adds defense-in-depth.

### 4. CORS Wildcard with Credentials — MEDIUM

**File:** `packages/core/src/dashboard/server.ts:340-344`  
**Severity:** MEDIUM  
**Code:**
```ts
const origin = this.config.corsOrigin || '*';
res.setHeader('Access-Control-Allow-Origin', origin);
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

Default CORS origin is `*` (wildcard) while `Access-Control-Allow-Credentials` is `true`. Per CORS spec, `Access-Control-Allow-Origin: *` with credentials is not valid — browsers will reject credentialed requests when origin is `*`. More importantly, if a user changes `corsOrigin` to a specific origin but doesn't also restrict `corsOrigin` in the webchat channel, any origin can make authenticated requests.

The same pattern exists in `packages/core/src/channels/webchat.ts:145,190-191`.

**Recommended fix:** 
- Default to `127.0.0.1` instead of `*` when running locally
- Reject `*` as a valid value when credentials are enabled
- Log a warning when CORS is set to wildcard in production

### 5. Shell Tool Passes Raw Command to `exec()` — MEDIUM

**File:** `packages/core/src/tools/impl/shell.ts:114`  
**Severity:** MEDIUM  
**Code:**
```ts
exec(command, {
  cwd,
  timeout,
  maxBuffer: 1024 * 1024,
  env: { ...process.env },
}, (err, stdout, stderr) => { ... });
```

The `command` parameter is passed directly to `child_process.exec()` which runs through a shell (`/bin/sh -c`). While the tool has `requiresApproval: true` and does sandbox the working directory, the command itself is unsanitized — shell injection is possible through the command string (by design, since the purpose is shell execution). 

This is a known trade-off for shell tools, but the risk is that an LLM-generated command could contain unintended malicious content. The tool does have path traversal protection for `cwd` but no command filtering.

**Recommended fix:**
- Add optional command validation/blocklist (e.g., block `rm -rf /`, `mkfs`, etc.)
- Consider using `execFile` with parsed args instead of shell string for simple commands
- Add a command logging layer so all executed commands are auditable
- The safety system in `self-constraints.ts` partially addresses this but only at the LLM output level, not at the tool execution level

### 6. Process Manager Spawns Without Sanitization — MEDIUM → reassessed to LOW

**File:** `packages/core/src/tools/impl/process-manager.ts:98`  
**Severity:** LOW  
**Code:**
```ts
const parts = command.split(/\s+/);
const cmd = parts[0];
const args = parts.slice(1);
const child = spawn(cmd, args, { ... });
```

The command is split on whitespace and passed to `spawn` (not `exec`), which is better since it doesn't run through a shell. However, the split is naive — quoted arguments with spaces will be broken. More relevant to security: the command and args are user-controlled with `requiresApproval: true`.

**Recommended fix:** Use a proper shell argument parser (e.g., `shell-quote` package) or document this as accepted risk with the approval gate being the control.

### 7. Config Loader Does Not Log Secrets — LOW (PASS)

**File:** `packages/core/src/config-loader.ts`  
**Severity:** LOW (Informational — no issue)  

The config loader reads `apiKey` from config and env vars but does **not** log or print config values. It logs validation errors and general status messages (`"Config validation failed"`, `"Failed to load config"`), but never outputs the config contents including API keys.

The `config show` CLI command (`packages/cli/src/commands/config.ts`) also carefully avoids printing `apiKey`, `apiToken`, or `token` values — it only shows non-sensitive fields like provider, model, context window, max tokens, and base URL.

**Status:** ✅ PASS — No secrets leaked in config loading or display.

### 8. No Hardcoded Secrets in Source Code — LOW (PASS)

**File:** All `packages/*/src/**/*.ts`  
**Severity:** LOW (Informational — no issue)  

Grep for `api_key`, `apikey`, `secret`, `password`, `token`, `bearer`, `auth key` across all source files found only:
- Environment variable references (`process.env.OPENAI_API_KEY`, `process.env.TELEGRAM_BOT_TOKEN`, etc.)
- Config struct property names (`apiKey?: string`, `botToken?: string`)
- Template strings for config generation (`apiKey: ${OPENAI_API_KEY}` — these are env var references, not hardcoded values)
- Example placeholder values in init commands (`# OPENAI_API_KEY=sk-...`, `# ANTHROPIC_API_KEY=sk-ant-...`)

No actual secret values, hardcoded API keys, or credentials found in source code. ✅ PASS

### 9. Secrets Tool Encryption Verification — LOW (PASS)

**File:** `packages/core/src/tools/impl/secrets.ts`  
**Severity:** LOW (Informational — no issue)  

The secrets tool implementation is solid:
- ✅ Uses **AES-256-GCM** (authenticated encryption) via `createCipheriv('aes-256-gcm', key, iv)`
- ✅ Uses **random 12-byte (96-bit) IV** per encryption via `randomBytes(12)` — unique per entry
- ✅ Stores **auth tag** and verifies it on decrypt via `setAuthTag()`
- ✅ Encrypted file written with **mode 0o600** (owner read/write only) via `writeFileSync(..., { mode: 0o600 })`
- ✅ Secret values **masked** in summaries (`***`)
- ✅ `get` returns value in `data` but sets `includeInContext: false` — prevents auto-inclusion in LLM context
- ✅ `list` returns key names only, never values
- ✅ `set`/`delete` require approval (`requiresApproval: true`)
- ✅ Key derivation uses `scryptSync` (memory-hard KDF)

The only weakness is the fallback key derivation (Finding #2 above).

**Status:** ✅ PASS with caveat (see Finding #2)

---

## SQL Injection Deep Dive

The database tool (`database.ts`) was reviewed for SQL injection:

- **`query` action:** Uses `db.prepare(sql)` with `stmt.all(...queryParams)` — parameterized ✅
- **`execute` action:** Uses `db.prepare(sql)` with `stmt.run(...execParams)` — parameterized ✅
- **`migrate` action:** Uses `db.exec(sql)` — accepts raw SQL by design (DDL statements can't be parameterized). This is expected behavior for migrations. ✅ (accepted risk)
- **`list-tables` action:** Hardcoded query, no user input ✅
- **`schema` action (SQLite):** `db.prepare(\`PRAGMA table_info(${table})\`)` — **VULNERABLE** (Finding #1)
- **`schema` action (Postgres):** Uses `client.query('... WHERE table_name = $1', [table])` — parameterized ✅

The PostgreSQL implementation is fully parameterized including the schema action. Only the SQLite `PRAGMA` path has the injection issue.

---

## Command Injection Deep Dive

- **`shell.ts`:** Uses `exec()` with raw command string — runs through shell. This is by design for a shell tool. The `cwd` is sandboxed and path traversal is blocked. The approval gate is the primary control. (Finding #5)
- **`process-manager.ts`:** Uses `spawn(cmd, args)` with naive whitespace split. No shell, so no shell injection, but argument parsing is fragile. (Finding #6)
- **`clipboard.ts`:** Uses `execFile(cmd, args)` with fixed commands (`pbpaste`, `pbcopy`, `xclip`) and fixed/no args. No user-controlled command. ✅ PASS
- **`code-exec.ts`:** Uses `execFile(cmd, args)` for Python/Node execution. Code is written to temp file and executed. This is by design for a code execution tool. The approval gate controls this. ✅ PASS (accepted risk)
- **`git.ts`:** Uses `execFile('git', gitArgs)` — fixed command, args are parameterized. ✅ PASS
- **`transcribe.ts`:** Uses `execFileAsync('whisper', args)` — fixed command, structured args. ✅ PASS
- **`image-gen.ts`:** Uses `execFileAsync('python3', [scriptPath])` — fixed command, file path arg. ✅ PASS
- **`ocr.ts`:** Uses `execFileAsync('tesseract', [imagePath, 'stdout', '-l', lang])` — fixed command, structured args. ✅ PASS
- **`notify.ts`:** Uses `execFileAsync('osascript', ['-e', script])` — the `script` variable contains user-provided text for the notification. However, this is the notification message text, not a command, and `execFile` doesn't run through a shell. The `-e` flag tells `osascript` to execute the script as AppleScript. This could theoretically allow AppleScript injection if the notification text contains AppleScript syntax. **LOW risk** — the notification text is crafted by the LLM, not raw user input.

---

## Summary Table

| # | Finding | File | Severity | Status |
|---|---------|------|----------|--------|
| 1 | SQL injection in SQLite PRAGMA | database.ts:158 | HIGH | ❌ Fix needed |
| 2 | Weak fallback encryption key | secrets.ts:81,87 | MEDIUM | ⚠️ Improve |
| 3 | .gitignore missing secret patterns | .gitignore | MEDIUM | ⚠️ Improve |
| 4 | CORS wildcard + credentials | dashboard/server.ts:340, webchat.ts:145 | MEDIUM | ⚠️ Improve |
| 5 | Shell exec unsanitized command | shell.ts:114 | MEDIUM | ⚠️ Accepted risk + improve |
| 6 | Process manager naive arg parsing | process-manager.ts:98 | LOW | ⚠️ Minor |
| 7 | Config loader doesn't log secrets | config-loader.ts | LOW | ✅ PASS |
| 8 | No hardcoded secrets in source | all source files | LOW | ✅ PASS |
| 9 | Secrets encryption (AES-256-GCM) | secrets.ts | LOW | ✅ PASS |

---

## Recommendations (Prioritized)

1. **Immediate:** Fix SQLite `PRAGMA table_info` SQL injection — validate table name with regex `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
2. **Short-term:** Improve `.gitignore` with explicit secret patterns (`.env.*`, `*.key`, `*.pem`, `*.enc.json`, `lancedb/`)
3. **Short-term:** Change CORS default from `*` to `127.0.0.1` and warn when wildcard is used in production
4. **Medium-term:** Improve fallback key derivation in secrets tool — generate and persist a random key with `0o600` permissions instead of using hostname:username
5. **Medium-term:** Add command audit logging to shell tool for security traceability
6. **Low priority:** Use proper shell argument parser in process-manager.ts
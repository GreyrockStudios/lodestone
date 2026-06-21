# TODO/FIXME Audit Results — 2026-06-21

## Summary

- **Total TODO/FIXME matches found:** 10 lines across 3 files
- **Real actionable TODOs:** 1
- **Issues created:** 0 (gh auth token expired — cannot create issues)

## All Matches

### 1. `packages/core/src/safety/truth-binding.ts:588` — ✅ ACTIONABLE

```
TODO: Implement persistent guard statistics tracking. This method
currently returns zeros because guard results are not being aggregated
into a persistent store.
```

**Action needed:** Implement persistent guard statistics tracking with:

1. Private `guardStats` field accumulating counts per guard
2. `recordStats()` helper called after each guard run in `process()`
3. Persist stats to disk (e.g. `data/truth-binding-stats.json`)
4. Return accumulated stats from `getGuardStats()`

### 2. `packages/core/src/improvement/patch-automation.ts:195` — ❌ NOT ACTIONABLE

Description of what `proposeFromTemplates()` does (scans for TODO/FIXME comments). Not a TODO itself.

### 3. `packages/core/src/improvement/patch-automation.ts:229` — ❌ NOT ACTIONABLE

Description of what `scanSourceFiles()` does. Not a TODO itself.

### 4. `packages/core/src/improvement/patch-automation.ts:272-285` — ❌ NOT ACTIONABLE

Code implementing the TODO/FIXME scanning logic (regex matching, pushing findings). Not TODOs themselves.

### 5. `packages/core/src/improvement/multi-agent.ts:537-538` — ❌ NOT ACTIONABLE

Code checking for TODO/FIXME/HACK comments as part of code quality analysis. Not a TODO itself.

### 6. `packages/core/src/improvement/multi-agent.ts:543` — ❌ NOT ACTIONABLE

Description string in code quality check output. Not a TODO itself.

## GitHub Issue to Create (after re-auth)

**Title:** Implement persistent guard statistics tracking in TruthBinding
**Labels:** todo
**Body:**

## TODO: Implement persistent guard statistics tracking

**File:** `packages/core/src/safety/truth-binding.ts` (line ~588)

### Current State

The `getGuardStats()` method currently returns zeros because guard results are not being aggregated into a persistent store.

### What Needs to Be Done

1. Add a private `guardStats` field to the `TruthBindingSystem` class that accumulates counts per guard (totalChecks, byGuard) and tracks block/warn/pass counts.
2. Update the `process()` method to call a private `recordStats()` helper that increments the counters after each guard run.
3. Persist the stats to disk (e.g. `data/truth-binding-stats.json`) so they survive across restarts.
4. Return the accumulated stats from `getGuardStats()`.

### Source Comment

```
TODO: Implement persistent guard statistics tracking. This method
currently returns zeros because guard results are not being aggregated
into a persistent store.
```

### Acceptance Criteria

- [ ] `getGuardStats()` returns real cumulative statistics
- [ ] Stats persist across process restarts
- [ ] Stats track per-guard: totalChecks, blocks, warnings, passes
- [ ] Unit tests verify stats accumulation and persistence

## Blocker

GitHub CLI token for `greyrock-flint` is expired. Run `gh auth login -h github.com` to re-authenticate, then create the issue above.

# Lodestone Architecture Decision Records

## ADR-001: Standalone Runtime (No OpenClaw Dependency)

**Date:** 2026-06-16
**Status:** Decided
**Context:** We need an agent engine that provides memory, self-improvement, proactivity, and knowledge compounding. We currently run on OpenClaw but want to own the full stack.
**Decision:** Build our own LLM runtime from day 1. No OpenClaw dependency.
**Reasoning:** 
- The behavioral layer IS the product. The runtime is where it lives.
- Building on OpenClaw means we're always working around someone else's architecture instead of designing for our primitives (memory, proactivity, self-improvement).
- We've learned what works and what doesn't from months of running OpenClaw daily. That knowledge is our competitive advantage.
- Long-term, owning the runtime means we control the optimization surface for our specific use case.
**Consequences:**
- Longer time to first working prototype (months vs weeks)
- We must solve: LLM abstraction, tool execution, streaming, session management, channel routing, auth
- Full control over the entire stack
- No dependency on external runtime licensing or breaking changes

## ADR-002: Product Name — Lodestone

**Date:** 2026-06-16
**Status:** Decided
**Context:** Need a product name for the standalone agent engine.
**Decision:** Lodestone
**Reasoning:** A lodestone is a naturally magnetized mineral — it attracts. Like our engine attracts knowledge to itself. Echoes Flint (both are rocks, both spark something). Professional, memorable, available domain potential.

## ADR-003: Milestone 1 Scope

**Date:** 2026-06-16
**Status:** Decided
**Context:** Need a concrete first milestone to validate the concept.
**Decision:** Docker Compose that boots an agent that starts thinking proactively within 5 minutes.
**Milestone criteria:**
1. Docker Compose boots: engine + vector DB + runtime
2. User provides identity via config files (SOUL.md, etc.)
3. Agent has full memory system (wiki + vector + scratch)
4. Agent has self-improvement loops (prediction journal, drift detection)
5. Agent runs sensorium health checks proactively
6. Agent consolidates knowledge on a sleep cycle
7. Within 5 minutes of boot, the agent has: read its identity, checked system health, and surfaced at least one proactive insight
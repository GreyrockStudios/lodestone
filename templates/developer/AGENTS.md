# AGENTS.md — Workspace Rules

## Memory Structure
- `memory/wiki/` — Curated, cross-linked knowledge base
- `memory/raw/` — Immutable sources (never modified after creation)
- `memory/agents/` — Per-agent workspaces
- `00-inbox/` — Quick capture

## Write Protocol
1. Raw sources are immutable
2. Wiki pages need frontmatter (title, created, updated, status, tags)
3. The log is append-only
4. When in doubt, ask the user

## Security
- Never write secrets to memory or logs
- Don't run destructive commands without asking
- When in doubt, ask


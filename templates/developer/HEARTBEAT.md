# HEARTBEAT.md — {{name}}

Pick one thing and make progress. If nothing's active, HEARTBEAT_OK.

## Active

- **[Project 1]** — Status. See [[project-1]].
- **[Project 2]** — Status. See [[project-2]].

_Replace these with your actual projects. Remove completed ones._

## Learning

- **TypeScript patterns** — Advanced type gymnastics, utility types
- **Performance profiling** — Node.js and browser perf tools
- **Testing strategies** — Property-based testing, mutation testing

## Health Checks

- **Main API:** `curl -sf http://localhost:3000/health || echo "API DOWN"`
- **Database:** `pg_isready -h localhost -q || echo "DB DOWN"`
- **Redis:** `redis-cli ping || echo "REDIS DOWN"`
- **Build:** `npm run build 2>&1 | tail -1`

## Rules

- If there's active work, make progress. Commit when tests pass.
- If tests are red, fixing them is the priority.
- If no active work, pick something from the learning queue or tackle tech debt.
- If nothing to do, HEARTBEAT_OK.
# Contributing to Lodestone

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
# Clone
git clone https://github.com/greyrockstudios/lodestone.git
cd lodestone

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run dogfood tests (requires Ollama running)
npm run test:dogfood

# Run the agent
npm start
```

## Project Structure

```
packages/
  core/          — Engine, agent loop, memory, safety, improvement
  cli/           — Command-line interface
docs/            — Documentation
docker/          — Docker files
examples/        — Example agents
```

## Key Modules

- `packages/core/src/engine.ts` — Main engine, wires everything together
- `packages/core/src/agent-loop.ts` — LLM orchestration, tool execution
- `packages/core/src/tools/` — Tool implementations + registry
- `packages/core/src/improvement/` — Self-improvement subsystems
- `packages/core/src/safety/` — Capability tiers, quality gates, behavioral learning
- `packages/core/src/memory/` — Wiki, vector store, knowledge graph, compounding
- `packages/core/src/channels/` — Telegram, Discord, webchat, email, voice

## Adding a New Tool

1. Create `packages/core/src/tools/impl/my-tool.ts`
2. Implement the `Tool` interface (`definition` + `execute`)
3. Register it in `packages/core/src/main.ts`

```typescript
export class MyTool implements Tool {
  readonly definition = {
    id: 'my-tool',
    name: 'My Tool',
    description: 'Does something useful',
    parameters: [...],
    sideEffects: false,
    requiresApproval: false,
  };

  async execute(params, context): Promise<ToolResult> {
    return { success: true, data: ..., summary: '...', durationMs: 0, includeInContext: true };
  }
}
```

## Adding a New Channel

1. Create `packages/core/src/channels/my-channel.ts`
2. Extend the `Channel` base class — implement `sendRaw()` and `getMaxMessageLength()`
3. Register it in the channel manager

The base class handles retry, rate limiting, message splitting, and health monitoring automatically.

## Testing

- `npm test` — E2E tests (218 tests across 4 suites)
- `npm run test:dogfood` — Integration tests with real LLM calls
- `npm run test:all` — Everything

## Before Submitting a PR

1. `npm run build` — Must compile clean
2. `npm test` — All tests must pass
3. No new console.log — use the structured Logger
4. Follow existing code style (no semicolons, single quotes, 2-space indent)

## Questions?

Open an issue or join the Discord (coming soon).
# @searchicus/core

Shared building blocks for every searchicus front door (CLI, HTTP API, MCP
server, UI):

- `SearchQuery` / `SearchResult` / `SearchResponse` — the common data shapes.
- `SearchQuerySchema` — a zod schema that validates and trims a `SearchQuery`.
- `SearchRequestSchema` — the shared API/MCP request schema, which adds an
  optional, non-empty, duplicate-free `engines` selection.
- `SearchEngine` — the plugin interface a backend search engine implements.
- `SearchEngineRegistry` — registers engines and fans a query out to one or
  all of them, capturing per-engine failures instead of throwing.
- `MockSearchEngine` — a deterministic, dependency-free engine used until
  real backends are plugged in.
- `createDefaultRegistry()` — builds the registry every front door
  (CLI/API/MCP) uses by default: just `MockSearchEngine`, for now.

## Usage

```ts
import { createDefaultRegistry } from "@searchicus/core";

const registry = createDefaultRegistry();

const response = await registry.search("mock", { query: "typescript", limit: 5 });
// or fan out across every registered engine:
const outcomes = await registry.searchAll({ query: "typescript", limit: 5 });
```

Each call to `createDefaultRegistry()` returns a fresh `SearchEngineRegistry`
instance — it's a factory, not a shared singleton — so callers (including
tests) can freely mutate what they get back without affecting anyone else.

## Adding a real engine

Implement `SearchEngine` (`id`, `name`, `search(query)`) and `.register()` it
in `createDefaultRegistry()` (`src/registry.ts`) — every front door
(CLI/API/MCP) picks it up automatically since they all build their registry
by calling that one function. Nothing else in this package needs to change.
Engine ids must be stable and unique; callers use them to select a backend.

## Scripts

```bash
npm run build -w @searchicus/core   # tsc -> dist/
npm run test -w @searchicus/core    # vitest
npm run typecheck -w @searchicus/core
```

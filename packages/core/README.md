# @searchicus/core

Shared building blocks for every searchicus front door (CLI, HTTP API, MCP
server, UI):

- `SearchQuery` / `SearchResult` / `SearchResponse` — the common data shapes.
- `SearchQuerySchema` — a zod schema that validates untrusted input (HTTP
  bodies, MCP tool arguments) into a `SearchQuery`.
- `SearchEngine` — the plugin interface a backend search engine implements.
- `SearchEngineRegistry` — registers engines and fans a query out to one or
  all of them, capturing per-engine failures instead of throwing.
- `MockSearchEngine` — a deterministic, dependency-free engine used until
  real backends are plugged in.

## Usage

```ts
import { MockSearchEngine, SearchEngineRegistry } from "@searchicus/core";

const registry = new SearchEngineRegistry().register(new MockSearchEngine());

const response = await registry.search("mock", { query: "typescript", limit: 5 });
// or fan out across every registered engine:
const outcomes = await registry.searchAll({ query: "typescript", limit: 5 });
```

## Adding a real engine

Implement `SearchEngine` (`id`, `name`, `search(query)`) and `register()` it
on a `SearchEngineRegistry` wherever your app constructs one (see the CLI,
API, and MCP packages for examples of that wiring). Nothing else in this
package needs to change.

## Scripts

```bash
npm run build -w @searchicus/core   # tsc -> dist/
npm run test -w @searchicus/core    # vitest
npm run typecheck -w @searchicus/core
```

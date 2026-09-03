# searchicus

A search proxy: send one query out to multiple backend search engines and get
back a unified set of results. Searchicus is built as a small TypeScript
monorepo with a shared core, and several front doors onto that core:

- **CLI** — run searches from a terminal
- **HTTP API** — a JSON API for programmatic access
- **MCP server** — a Model Context Protocol server (Streamable HTTP
  transport) so AI agents/tools can search through it
- **Web UI** — a minimal browser UI for interactive search

The set of backend search engines is designed to be **pluggable**: every
engine implements one small interface and is registered with the core
registry. Implementing real backends (e.g. web search providers) is
intentionally **out of scope for this initial scaffold** — the core ships
with a deterministic mock engine so every surface (CLI/API/MCP/UI) can be
exercised end to end without external dependencies or API keys.

## Status

The scaffold is complete: `core`, `cli`, `api`, `mcp`, and `ui` all build,
typecheck, lint, and have passing tests. The API, MCP tool server, CLI, and
UI are covered at their adapter boundaries; the MCP suite also makes a real
Streamable HTTP request. Every surface currently searches against the `core`
package's mock engine — see "Adding a new search engine backend" below for
what plugging in a real one looks like.

## Architecture

```
                          ┌───────────────┐
                          │  core package │
                          │  - types      │
                          │  - engine     │
                          │    interface  │
                          │  - registry   │
                          │  - mock engine│
                          └───────┬───────┘
                                  │
        ┌───────────┬────────────┼────────────┬────────────┐
        │            │            │            │
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
   │   cli   │  │   api   │  │   mcp   │  │   ui    │
   │ command │  │  HTTP   │  │ MCP     │  │ browser │
   │  line   │  │  JSON   │  │ server  │  │  app    │
   └─────────┘  └─────────┘  └─────────┘  └─────────┘
```

All of the search-facing surfaces (CLI, HTTP API, MCP server) are thin
adapters over the `core` package's `SearchEngineRegistry`. The web UI talks
to the HTTP API.

## Repository layout

```
searchicus/
├── packages/
│   ├── core/   # shared types, SearchEngine interface, registry, mock engine
│   ├── cli/    # `searchicus` command-line tool
│   ├── api/    # HTTP API server
│   ├── mcp/    # MCP server (Streamable HTTP transport)
│   └── ui/     # web UI
├── AGENTS.md   # notes for humans and AI coding agents working in this repo
└── README.md
```

## Getting started

```bash
npm install
npm run build   # builds every package (core first — the others depend on it)
```

Run the API, MCP server, and UI dev servers together:

```bash
npm run dev
```

That starts the HTTP API on `:3000`, the MCP server on `:3001`, and the
Vite dev server (UI) on `:5173`, wired together (the UI dev server proxies
`/api/*` to the HTTP API). Or run any one of them on its own — see each
package's README (`packages/{core,cli,api,mcp,ui}/README.md`) for details:

```bash
npm run dev -w @searchicus/api
npm run dev -w @searchicus/mcp
npm run dev -w @searchicus/ui

# CLI (no long-running server — build once, then invoke it directly)
npm run build -w @searchicus/cli
node packages/cli/dist/index.js search "typescript generics"
```

Other useful root-level scripts (each runs across every package):

```bash
npm test           # builds core as needed, then runs Vitest per package
npm run typecheck  # builds core declarations as needed, then runs tsc --noEmit
npm run lint       # eslint .
npm run format     # prettier --write .
```

## Adding a new search engine backend

Real backends aren't implemented yet, by design — see "Status" above. The
intended shape: implement the `SearchEngine` interface from `core` (`id`,
`name`, `search(query)`) and `.register()` it on the `SearchEngineRegistry`
each front door builds in its own `createRegistry()` — see `src/app.ts` in
`api`, `src/server.ts` in `mcp`, or `src/index.ts` in `cli`. That's currently
the one place in each package that would change; nothing else assumes the
mock engine. Keep engine ids stable and unique: callers can select them in
the API, MCP tool, and CLI.

## License

MIT — see [LICENSE](./LICENSE).

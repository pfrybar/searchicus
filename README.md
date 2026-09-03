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

This repository is being scaffolded incrementally; see the commit history
for how each piece was added. Check back here for the parts that are wired
up so far.

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

> Tooling is being layered in commit by commit — this section will fill out
> as each package lands. Once the workspace is set up:

```bash
npm install
npm run build --workspaces --if-present
```

Individual package READMEs (as they're added under `packages/*`) will cover
running the CLI, API, MCP server, and UI.

## Adding a new search engine backend

Not yet implemented, by design — see "Status" above. The intended shape is:
a package/module implementing the `SearchEngine` interface from `core`
(`id`, `name`, `search(query)`), registered with the `SearchEngineRegistry`
that the CLI/API/MCP server construct at startup. That registration wiring
is left open on purpose so real backends can be dropped in later without
changing any of the front doors.

## License

MIT — see [LICENSE](./LICENSE).

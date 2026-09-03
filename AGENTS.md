# AGENTS.md

Notes for anyone (human or AI coding agent) working in this repository.

## What this is

`searchicus` is a search proxy: one query in, results from multiple backend
search engines out. It's a TypeScript npm-workspaces monorepo with a shared
`core` package and four front doors: a CLI, an HTTP API, an MCP server
(Streamable HTTP transport), and a web UI. See `README.md` for the
architecture picture.

Pluggable backend search engines are **out of scope for now**. The `core`
package defines the `SearchEngine` plugin interface and ships a
deterministic `MockSearchEngine` so the rest of the stack has something real
to call. Don't add real backend integrations (web search providers, API-key
based engines, etc.) unless explicitly asked — the interface is the point of
this phase, not the integrations.

## Repo layout

```
packages/
  core/   shared types + SearchEngine interface + registry + mock engine
  cli/    `searchicus` CLI (commander)
  api/    HTTP API (express)
  mcp/    MCP server, Streamable HTTP transport (@modelcontextprotocol/sdk)
  ui/     web UI (vite + react)
```

Each package is independently versioned/built under `packages/*`. Internal
packages currently declare the matching `0.1.0` version of `@searchicus/core`;
npm workspaces resolves that compatible dependency to the local workspace, so
no publishing is required for local development. Keep those versions aligned
if a package version changes.

## Conventions

- **Language**: TypeScript everywhere, `strict` mode on. Compiled output
  goes to each package's `dist/`, which is git-ignored.
- **Module format**: ESM (`"type": "module"`) across all packages.
- **Package manager**: npm (workspaces). Don't add a lockfile from another
  package manager (pnpm/yarn) — `package-lock.json` at the repo root is the
  single source of truth for installed versions.
- **Shared config**: `tsconfig.base.json` at the repo root holds common
  compiler options; each package's `tsconfig.json` extends it.
- **Naming**: package directories are the unscoped feature name
  (`packages/cli`, not `packages/searchicus-cli`); npm package names are
  scoped as `@searchicus/<name>`.

## Common commands

Run from the repo root unless noted otherwise.

```bash
npm install         # install everything
npm run build       # build all packages; dependent package hooks build core first
npm run test         # build core as needed, then run all Vitest suites
npm run lint         # eslint across the repo
npm run format       # prettier --write
npm run typecheck    # build core declarations as needed, then tsc --noEmit
```

`npm run dev` starts the API, MCP server, and UI dev servers together
(via `concurrently`); each is also runnable on its own:

```bash
npm run dev -w @searchicus/api   # HTTP API with reload, :3000
npm run dev -w @searchicus/mcp   # MCP Streamable HTTP server, :3001
npm run dev -w @searchicus/ui    # Vite dev server, :5173 (proxies /api to :3000)
npm run build -w @searchicus/cli && node packages/cli/dist/index.js search "query"
```

## Working style expected in this repo

- Prefer small, focused commits that each leave the repo in a working
  state (installs, builds, and — once tests exist — passes them).
- When adding a package, give it its own `package.json`, `tsconfig.json`,
  and a short `README.md` describing what it does and how to run it.
- Keep the `SearchEngine` interface in `core` minimal and stable; the CLI,
  API, and MCP server should each be a thin adapter over
  `SearchEngineRegistry`, not reimplement search logic themselves.
- Validate untrusted requests through the shared core schemas. `SearchQuery`
  is the engine input; `SearchRequest` adds the optional engine selection for
  API/MCP callers. Do not recover `engines` by casting raw request bodies.
- If you touch the plugin interface or shared request schemas, update the
  mock engine and every adapter (CLI/API/MCP/UI) that assumes their current
  shape, plus their tests and package README files.
- Consumers import core's built ESM entry point. Their `prebuild`, `predev`,
  `pretest`, and `pretypecheck` hooks deliberately build core first, so keep
  those hooks when changing package scripts or adding another core consumer.

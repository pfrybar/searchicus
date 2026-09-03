# AGENTS.md

Notes for anyone (human or AI coding agent) working in this repository.

## What this is

`searchicus` is a search proxy: one query in, results from multiple backend
search engines out. It's a TypeScript npm-workspaces monorepo with a shared
`core` package and four front doors: a CLI, an HTTP API, an MCP server
(Streamable HTTP transport), and a web UI. The HTTP API and MCP server share
one process and one package (`packages/api`). See `README.md` for the
architecture picture.

Backend engines drive a real headless browser. `core` owns a single
long-lived Chromium instance (Playwright `launchPersistentContext`) and
hands each search a page from it; engines parse results out of that page.
A deterministic `MockSearchEngine` is still registered by default so the
whole stack runs — and the whole test suite passes — with no browser
installed at all.

## Repo layout

```
packages/
  core/   shared types + SearchEngine interface + registry + mock engine
          + browser session (Playwright) + rate-limit throttle
  cli/    `searchicus` CLI (commander)
  api/    HTTP API (express) + MCP endpoint at /mcp, mounted from src/mcp/
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

Browser-backed tests skip automatically when Chromium can't launch (a slim
container usually lacks `libnss3`/`libgbm`/`libX11`, and
`playwright install-deps` needs root). They are the only coverage of the real
Playwright wiring, so run them somewhere with a working browser before
trusting changes to `browser.ts`.

`npm run dev` starts the API, MCP server, and UI dev servers together
(via `concurrently`); each is also runnable on its own:

```bash
npm run dev -w @searchicus/api   # HTTP API + MCP with reload, :3000 (MCP at /mcp)
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
- Engines are registered once, in core's `createDefaultRegistry()`
  (`packages/core/src/registry.ts`) — every front door defaults to calling
  it rather than building its own registry. Add a new engine there, not per
  package. It's a factory (fresh instance per call), not a shared singleton,
  so `createApp`/`createProgram`/`createMcpServer` can keep accepting an
  injectable `registry` parameter for tests.
- **Playwright must never reach core's main entry.** `createDefaultRegistry()`
  has no browser attached on purpose; `browser.ts` is published separately as
  `@searchicus/core/browser` and only entry points import it. The UI
  type-imports from core, so a value import of Playwright there would drag
  browser binaries into a Vite bundle. The registry depends on the
  `BrowserProvider` interface, never on the `BrowserSession` class.
- **Results and sessions are separate signals.** `search()` resolving means
  results are ready; the returned `SearchSession.completed` settling means
  the browser work is done. An engine may return results and keep using its
  page. The registry releases the browser lease when `completed` settles, so
  an engine that never settles it leaks a page into a browser that is meant
  to run for days. Engines with nothing to do afterwards just return a bare
  `SearchResponse` and the registry normalizes it.
- **Anything short-lived must `drain()` before exiting.** Sessions outlive the
  call that started them, so exiting as soon as results arrive kills live
  browser work. The CLI `close()`s in a `finally`; the servers drain on
  SIGINT/SIGTERM with a grace period.
- **Rate limiting is the registry's job, not each engine's.** One global
  throttle gates entry to `searchAll()`, so a single incoming search still
  fans out to every engine in parallel while _consecutive_ searches are
  spaced apart (5s ±30% jitter by default). Tests that run searches back to
  back should pass `{ throttle: null }`.
- **One browser, one context, a page per search — deliberately no pool.** A
  pool would isolate concurrent searches; sharing one persistent context is
  what carries cookies, dismissed consent banners, and cache across searches
  and across restarts. Each surface gets its own profile directory because a
  Chromium user-data dir is single-writer and `npm run dev` starts the API
  and MCP server together.
- **MCP is mounted, not a separate service.** `createMcpRouter` is stateless
  (a fresh `McpServer` per request), so it mounts as an ordinary router in
  the API app and is toggled with `createApp(registry, { mcp })` /
  `MCP_ENABLED`. Keep it mounted _before_ the catch-all 404, which would
  otherwise swallow every MCP request, and keep MCP failures in JSON-RPC
  error shape — body-parse errors reach the shared error middleware, not the
  MCP router, so that branch has to stay.
- Validate untrusted requests through the shared core schemas. `SearchQuery`
  is the engine input; `SearchRequest` adds the optional engine selection for
  API/MCP callers. Do not recover `engines` by casting raw request bodies.
- If you touch the plugin interface or shared request schemas, update the
  mock engine and every adapter (CLI/API/MCP/UI) that assumes their current
  shape, plus their tests and package README files.
- Consumers import core's built ESM entry point. Their `prebuild`, `predev`,
  `pretest`, and `pretypecheck` hooks deliberately build core first, so keep
  those hooks when changing package scripts or adding another core consumer.

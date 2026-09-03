# searchicus

A search proxy: send one query out to multiple backend search engines and get
back a unified set of results. Searchicus is built as a small TypeScript
monorepo with a shared core, and several front doors onto that core:

- **CLI** — run searches from a terminal
- **HTTP API** — a JSON API for programmatic access
- **MCP server** — a Model Context Protocol server (Streamable HTTP
  transport) so AI agents/tools can search through it, served from the same
  process as the HTTP API
- **Web UI** — a minimal browser UI for interactive search

The set of backend search engines is **pluggable**: every engine implements
one small interface and is registered with the core registry. Engines run
against a real headless browser — core keeps a single long-lived Chromium
instance with a persistent profile and hands each search a page from it.
A deterministic mock engine is also registered, so every surface
(CLI/API/MCP/UI) can be exercised end to end with no browser installed.

## Status

`core`, `cli`, `api`, `mcp`, and `ui` all build, typecheck, lint, and have
passing tests. The API, MCP tool server, CLI, and UI are covered at their
adapter boundaries; the MCP suite also makes a real Streamable HTTP request.

The browser layer — persistent Chromium session, page-per-search leases,
two-phase search sessions, and rate limiting — is in place in `core`. Only
the mock engine ships with it; see "Adding a new search engine backend".

## Architecture

```
                          ┌────────────────┐
                          │  core package  │
                          │  - types       │
                          │  - engine      │
                          │    interface   │
                          │  - registry    │
                          │  - throttle    │
                          │  - browser     │
                          │    session     │
                          │  - mock engine │
                          └───────┬────────┘
                                  │
             ┌────────────────┼────────────────┐
             │                │                │
        ┌─────────┐   ┌───────────────┐   ┌─────────┐
        │   cli   │   │      api      │   │   ui    │
        │ command │   │  HTTP  +  MCP │   │ browser │
        │  line   │   │  JSON     /mcp│   │   app   │
        └─────────┘   └───────────────┘   └─────────┘
```

All of the search-facing surfaces (CLI, HTTP API, MCP server) are thin
adapters over the `core` package's `SearchEngineRegistry`. The web UI talks
to the HTTP API.

The HTTP API and the MCP server share **one process** (`packages/api`), with
MCP mounted at `POST /mcp` and toggleable via `MCP_ENABLED`. That's not just
packaging convenience: sharing a process means sharing one registry, and
therefore one rate-limit throttle and one persistent browser profile. Run as
two processes they would throttle independently and query the backends at
twice the configured rate.

### The browser layer

Core runs **one** long-lived Chromium instance with **one** persistent
browser context, handing each search its own page. There is deliberately no
browser pool: a pool would isolate concurrent searches, but sharing a single
persistent context is what carries cookies, dismissed consent banners, and
cache across searches — and, because the profile lives on disk, across
process restarts too.

Two consequences shape the API:

- **Results and sessions are separate.** `search()` resolving means results
  are ready; the `SearchSession.completed` promise settling means the browser
  work is finished. An engine can return results immediately and keep paging
  or following links afterwards. The registry holds the browser lease until
  `completed` settles, which is why short-lived processes must `drain()`
  before exiting.
- **Searches are rate limited as whole fan-outs.** One global throttle gates
  entry to `searchAll()`, so a single query still hits every engine in
  parallel while consecutive searches are spaced apart (5s ±30% by default).

Each surface gets its own Chromium profile under `.searchicus/profile/`
(override with `SEARCHICUS_PROFILE_DIR`), because a user-data directory is
single-writer and `npm run dev` runs the API and MCP server side by side.

## Repository layout

```
searchicus/
├── packages/
│   ├── core/   # shared types, SearchEngine interface, registry, mock engine
│   ├── cli/    # `searchicus` command-line tool
│   ├── api/    # HTTP API server + MCP endpoint (Streamable HTTP)
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

That starts the HTTP API on `:3000` — with the MCP endpoint at
`:3000/mcp` — and the Vite dev server (UI) on `:5173`, wired together (the
UI dev server proxies `/api/*` to the HTTP API). Or run either on its own —
see each package's README (`packages/{core,cli,api,ui}/README.md`) for
details:

```bash
npm run dev -w @searchicus/api
MCP_ENABLED=false npm run dev -w @searchicus/api   # search API only
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

Implement the `SearchEngine` interface from `core` (`id`, `name`,
`search(query, ctx)`) and `.register()` it in `createDefaultRegistry()`
(`packages/core/src/registry.ts`). Every front door builds its registry by
calling that one function, so that's the only place that changes. Keep
engine ids stable and unique — callers select them in the API, MCP tool, and
CLI.

```ts
class ExampleEngine implements SearchEngine {
  readonly id = "example";
  readonly name = "Example";

  async search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    const { page } = await ctx.acquireBrowser();
    await page.goto(`https://example.com/search?q=${encodeURIComponent(query.query)}`);
    const results = await parseResults(page);

    return {
      response: { query, results, engine: this.id, tookMs: 0 },
      // Results are ready now; this settles when the page work is done.
      completed: prefetchNextPage(page),
    };
  }
}
```

`ctx.acquireBrowser()` is lazy — an engine that never calls it never causes
Chromium to launch, which is what keeps the mock engine and the test suite
browser-free. An engine with no work to do after returning results can just
return a bare `SearchResponse`; the registry normalizes both shapes.

Running a browser-backed engine needs Playwright's Chromium **and** its
system libraries:

```bash
npx playwright install chromium
sudo npx playwright install-deps   # needs root; slim containers lack these
```

Without them the browser-backed tests skip and browser-backed engines fail
with a `BrowserUnavailableError` explaining what's missing.

## License

MIT — see [LICENSE](./LICENSE).

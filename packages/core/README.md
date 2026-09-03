# @searchicus/core

Shared building blocks for every searchicus front door (CLI, HTTP API, MCP
server, UI):

- `SearchQuery` / `SearchResult` / `SearchResponse` — the common data shapes.
- `SearchQuerySchema` — a zod schema that validates and trims a `SearchQuery`.
- `SearchRequestSchema` — the shared API/MCP request schema, which adds an
  optional, non-empty, duplicate-free `engines` selection.
- `SearchEngine` — the plugin interface a backend search engine implements.
- `SearchSession` — an engine's two-phase result: the response plus a
  `completed` promise for browser work that outlives it.
- `SearchContext` / `BrowserLease` — what an engine is handed to get at a
  browser page.
- `SearchEngineRegistry` — registers engines, fans a query out to one or all
  of them capturing per-engine failures, and owns rate limiting and session
  lifetime.
- `Throttle` — spaces consecutive search fan-outs apart, with jitter.
- `MockSearchEngine` — a deterministic, browser-free engine.
- `createDefaultRegistry()` — the registry every front door uses by default.

Playwright lives behind a separate entry point, `@searchicus/core/browser`:

- `BrowserSession` — the single long-lived Chromium instance.
- `createDefaultBrowserSession(surface)` — **fill in browser configuration here.**
- `createBrowserRegistry(surface)` — a default registry with a real browser attached.

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

That registry has **no browser attached**. Surfaces that need one use the
browser entry point instead, and must shut it down:

```ts
import { createBrowserRegistry } from "@searchicus/core/browser";

const registry = createBrowserRegistry("api");
try {
  await registry.searchAll({ query: "typescript" });
} finally {
  await registry.close(); // drains live sessions, then closes Chromium
}
```

Keeping Playwright out of the main entry point is deliberate: the UI
type-imports from this package, and a value import would drag browser
binaries into a Vite bundle. The registry depends on the `BrowserProvider`
interface, never on `BrowserSession` itself.

## The browser model

One Chromium instance, one persistent `BrowserContext`, one page per search.
There is no pool. A pool would isolate concurrent searches; sharing a single
persistent context is what carries cookies, dismissed consent banners, and
cache between searches — and, since `launchPersistentContext` keeps a real
profile directory on disk, across process restarts too.

Each surface gets its own profile under `.searchicus/profile/<surface>/`
(override with `SEARCHICUS_PROFILE_DIR`), because a Chromium user-data
directory is single-writer and `npm run dev` starts the API and MCP server
together. They therefore don't share cookies with each other.

## Results vs. sessions

`search()` resolving means **results are ready**. `SearchSession.completed`
settling means **the browser work is finished**. An engine can hand back
results as soon as it has parsed the page and keep working afterwards:

```ts
async search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
  const { page } = await ctx.acquireBrowser();
  // ... navigate, parse ...
  return { response, completed: prefetchNextPage(page) };
}
```

The registry releases the browser lease when `completed` settles — including
when it rejects — so an engine that never settles it leaks a page into a
browser meant to run for days. Engines with nothing to do afterwards return
a bare `SearchResponse`; the registry normalizes both.

Because sessions outlive the call that started them, **a short-lived process
must `drain()` (or `close()`) before exiting**, or it kills live browser work.

## Rate limiting

One global `Throttle` gates entry to `searchAll()`, so a single incoming
search still queries every engine in parallel while _consecutive_ searches
are spaced apart — 5s ±30% jitter by default. Spacing is measured
start-to-start, so a session still running doesn't hold up the next search.

Since every fan-out touches every engine, each backend ends up seeing roughly
one query per interval without needing a timer of its own. A search that
targets a subset of engines is still spaced by the same global interval.

Tests that run searches back to back should disable it:

```ts
new SearchEngineRegistry({ throttle: null });
```

## Adding a real engine

Implement `SearchEngine` (`id`, `name`, `search(query, ctx)`) and
`.register()` it in `createDefaultRegistry()` (`src/registry.ts`) — every
front door picks it up automatically. `ctx.acquireBrowser()` is lazy, so an
engine that doesn't need a browser never causes Chromium to launch. Engine
ids must be stable and unique; callers use them to select a backend.

## Scripts

```bash
npm run build -w @searchicus/core   # tsc -> dist/
npm run test -w @searchicus/core    # vitest
npm run typecheck -w @searchicus/core
```

The `BrowserSession` suite skips automatically when Chromium can't launch —
a slim container typically lacks `libnss3`/`libgbm`/`libX11`, and
`playwright install-deps` needs root. Those tests are the only coverage of
the real Playwright wiring, so run them somewhere with a working browser
before trusting changes to `browser.ts`.

# @searchicus/core

Shared building blocks for every searchicus front door (CLI, HTTP API, MCP
server, UI):

- `SearchQuery` / `SearchResult` / `SearchResponse` — the common data shapes.
- `SearchQuerySchema` — a zod schema that validates and trims a `SearchQuery`.
- `SearchRequestSchema` — the shared API/MCP request schema, which adds a
  final merged-result `limit`.
- `SearchEngine` — the plugin interface a backend search engine implements;
  its optional `indexFamily` identifies correlated result sources for ranking.
- `SearchSession` — an engine's two-phase result: the response plus a
  `completed` promise for browser work that outlives it.
- `SearchContext` / `BrowserLease` — what an engine is handed to get at a
  browser page.
- `SearchEngineRegistry` — registers engines, merges a fan-out into the
  client-facing ranked response, retains `searchAll()` for raw per-engine
  debugging, and owns rate limiting, sessions, and queued archive writes.
- `SqliteSearchArchive` / `SearchArchive` — best-effort local persistence of
  merged responses and raw engine outcomes.
- `Throttle` — spaces consecutive search fan-outs apart, with jitter.
- `BingSearchEngine` / `BraveSearchEngine` / `DuckDuckGoSearchEngine` /
  `StartpageSearchEngine` — drive their search engines through a real browser:
  homepage, type, submit, parse. All need a browser-backed registry.
- `NoResultsError` / `OffTargetResultsError` / `SearchBoxUnavailableError` —
  the content-level failures any engine can hit, shared by all of them.
- `runBrowserSearch()` / `BrowserSearchSpec` — the interaction every engine
  performs, so an engine supplies only its homepage, selectors and parser.
- `readText()` / `readCollapsed()` / `readSnippet()` / `collapse()` — how a
  field is read off a SERP, guarded and style-stripped.
- `assessRelevance()` — scores a result set against its query, to catch a
  results page that parses cleanly but answers a different question.
- `rankResults()` / `canonicalizeUrl()` — merge per-engine outcomes into a
  family-aware, attributed result ranking without changing the raw outcomes.
- `createDefaultRegistry()` — the registry every front door uses by default.
- `createLogger()` / `setLogLevel()` — leveled logging on stderr, silent under
  test. See the root README's "Logging".
- `loadConfig()` — the whole configuration tree, read once from defaults, a
  YAML file and the environment. An invalid value throws `ConfigError` rather
  than falling back. See the root README's "Configuration".
- `changedSettings()` — the settings that are not their defaults, each with
  the layer that decided it, for a process that wants to say what it is
  running on.

Playwright lives behind a separate entry point, `@searchicus/core/browser`:

- `BrowserSession` — the single long-lived Chromium instance.
- `createDefaultBrowserSession(surface, config)` — the configured session each
  surface uses.
- `createBrowserRegistry(surface, config)` — a default registry with a real
  browser and the configured local archive attached when archival is enabled.

## Usage

```ts
import { createDefaultRegistry } from "@searchicus/core";

const registry = createDefaultRegistry();
const engines = registry.list(); // one instance of each engine, in registration order

// This browser-free registry is useful for registration and dependency
// injection. Run browser-backed engines through the /browser entry point.
```

Each call to `createDefaultRegistry()` returns a fresh `SearchEngineRegistry`
instance — it's a factory, not a shared singleton — so callers (including
tests) can freely mutate what they get back without affecting anyone else.

That registry has **no browser attached**. Surfaces that need one use the
browser entry point instead, and must shut it down:

```ts
import { loadConfig } from "@searchicus/core";
import { createBrowserRegistry } from "@searchicus/core/browser";

// One front door, one loadConfig(): the surface name picks the profile, and
// the configuration decides where it lives and how the fan-out is paced.
const registry = createBrowserRegistry("api", loadConfig());
try {
  await registry.search({ query: "typescript" });
} finally {
  await registry.close(); // drains live sessions, then closes Chromium
}
```

Keeping Playwright out of the main entry point is deliberate: the UI
type-imports from this package, and a value import would drag browser
binaries into a Vite bundle. The registry depends on the `BrowserProvider`
interface, never on `BrowserSession` itself.

For the same reason there is a third entry point, `@searchicus/core/ranking`,
holding the pure ranking module. The UI needs `canonicalizeUrl` as a **value**
— it decides which result a read belongs to — and reaching it through the root
pulls the SQLite archive and its node built-ins along with it, adding 82 kB to
the bundle. The subpath costs half a kilobyte.

## The browser model

One Chromium instance, one persistent `BrowserContext`, one page per search.
There is no pool. A pool would isolate concurrent searches; sharing a single
persistent context is what carries cookies, dismissed consent banners, and
cache between searches — and, since `launchPersistentContext` keeps a real
profile directory on disk, across process restarts too.

Persistent state defaults to `.searchicus/` at the application root — found
from the installed files, not from the working directory, so every surface
resolves the same state tree however its process was started. Each surface
gets its own profile under `profile/<surface>/`, and, when archival is
enabled, the application archive is the sibling `searchicus.sqlite`. Chromium
profiles are single-writer, so surfaces do not share cookies; the archive uses
WAL mode and is safe for API and CLI to share. Set `paths.dataDir` to move
both together, or use `paths.profileDir` / `paths.storePath` for a component
override.

An ungraceful host or container stop can leave Chromium's `SingletonLock`
behind. If it names a different hostname, launch failure explains the exact
lock path and the manual fix; searchicus never removes it by default. A
known-single-writer deployment can set `browser.profileUnlock` to
remove only that foreign-host lock and retry launch once. Do not enable it
where another process may legitimately own the profile.

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
when it rejects. An engine that never settles it does not leak a page: the
session cap (60s by default) aborts the run and releases the lease anyway, so
`drain()` and `close()` always finish. Settling `completed` is still an
engine's job; the cap is a backstop, not a schedule. Engines with nothing to
do afterwards return a bare `SearchResponse`; the registry normalizes both.

Because sessions outlive the call that started them, **a short-lived process
must `drain()` (or `close()`) before exiting**, or it kills live browser work.

## Search archive

`createBrowserRegistry()` also queues each completed fan-out for best-effort
archival, when it was given an archive to write to — off by default, so a
process that configures nothing keeps no history at all. The SQLite database
retains the detailed internal ranking and raw successful and failed engine
outcomes keyed by the same `search_id`; ordinary callers receive only a
generic projection of that ranking. Total engine failures are archived too,
even though they have no client response.

Archival happens after `search()` resolves and a write failure is swallowed;
it must never delay or alter the search response. `drain()` waits for queued
archive writes as well as browser sessions, and `close()` closes the database
after draining. The archive contains queries, result text and URLs, and engine
failure messages, so treat the local database as sensitive data. Set
`archive.enabled: true` to switch it on; it is off by default, because it
becomes a record of every query the process has ever run.

## Extraction

`createBrowserExtraction()` builds an `ExtractionService`: it renders one
caller-supplied URL and returns its main content as Markdown. It is the
sibling of `createBrowserRegistry()` and deliberately not part of it.

The two share an archive file and must never share a browser. Search drives a
single long-lived persistent profile carrying cookies, cache, and history —
exactly what should never be exposed to a URL a caller chose. Extraction gets
its own non-persistent `chromium.launch()` with a fresh context per request,
closed on every outcome. `launchPersistentContext` exposes no `Browser`, so
there is no way to blur that line even by accident.

```ts
import { createDefaultSearchArchive, loadConfig } from "@searchicus/core";
import { createBrowserExtraction, createBrowserRegistry } from "@searchicus/core/browser";

const config = loadConfig();
const archive = createDefaultSearchArchive(config);
const registry = createBrowserRegistry("api", config, { archive });
const extraction = createBrowserExtraction(config, { archive });

const page = await extraction.extract({ url: "https://example.com/" });
if (page.outcome === "usable") console.log(page.markdown);
else console.log(page.reason);
```

All three read methods share one cached usability assessment. Final remote
HTTP errors are classified before parsing; successful documents are withheld
only when wholly unreadable or when a narrow, deterministic known-interstitial
signature matches. The public `usable | unusable` union prevents adapters from
mistaking a challenge or 404 body for page content while keeping this distinct
from thrown transport/render/parser failures. Small positive word counts, flat
structure, generic error words, and `find` misses are not rejection signals.
Every response has `cached`, true only when that request reused an in-memory
parsed page without a render or parse; it is not an origin freshness signal.

A `text/plain` render bypasses Defuddle: Chromium has already decoded its
charset, so the captured body is retained as Markdown with normalized line
endings. This preserves headings in plain-text Markdown, RFCs, and READMEs for
both `outline` and `find`.

The pieces are separable. `ExtractionService` depends on a `PageRenderer`
interface rather than Playwright, so the whole flow can be driven with no
browser installed; the address policy in `extract/address.ts` is pure; and
Defuddle runs in a memory-capped worker so a pathological document cannot take
the host process with it.

Extraction is disabled unless `extract.enabled` is set, and every
other limit is operator configuration rather than a request field. Renders are
bounded two at a time with at most 32 callers waiting; past that
`ExtractionBusyError` refuses rather than promising a turn that will arrive
after the caller's own deadline. `close()` waits for archive writes it has
already started, so the owner of a shared archive can close it afterwards
without losing one. Read the
root README's "Extraction" section — particularly its network warning — before
enabling it.

Extract/find attempts and unusable outline observations are recorded as
metadata only: operation/status, stable unusable reason and
classifier/signature identifiers, timings, HTTP status, title, domain, and
sizes. Successful outlines are not archived. Usable returned Markdown may have
a digest; withheld bodies do not. Page text is never persisted, and the
`extractions` table has nowhere to put it — though a parsed page is held in
memory briefly so that reading its second window does not render it again. See
the root README's "Extraction" for that bound.

`find(request)` is the third read operation: it scores the page's sections
against a query with BM25 over that page's own sections — document frequency
across the chunks of one document, which measures how distinctive a term is
_here_ — and returns the best few whole, within a budget, alongside the same
`navigable` verdict `outline` reports so a caller can tell an honest miss from
a page that could not be searched by section at all. A section larger than the
budget is split at blank lines by `splitBlocks` and scored the same way over
its own blocks, so an oversized section yields its matching part rather than
its opening. The chunker is
`splitSections`, the same one `extract` windows with and `outline` describes,
so a match is addressed by the offset `extract` already takes. ICU token
boundaries are shared with `relevance.ts`; `find` applies Porter stemming only
to ordinary ASCII-Latin prose terms, leaving other scripts and technical
identifiers exact. The scorer deliberately is not shared. Constants live at
the top of `extract/find.ts` and are meant to be tuned.

A read records the URL it asked for and nothing about who sent the caller
there. `searchDetail` and `engineMetrics` match reads back to the searches
that offered them by canonicalized URL, at the point they are asked — so the
correlation is the operator's inference rather than something a caller had to
supply, and it is best-effort accordingly.

## Reading the archive back

`SqliteSearchArchive` also implements `ArchiveInsights`, the read side that the
dashboard is built on:

```ts
import { createDefaultSearchArchive, loadConfig } from "@searchicus/core";

const config = loadConfig();
const store = createDefaultSearchArchive(config);
if (!store) throw new Error("Set archive.enabled to read the archive");
await store.engineMetrics({ window: 200 }); // per-engine reliability and contribution
await store.recentSearches({ limit: 25 }); // newest first, keyset-paged
await store.searchDetail(searchId); // every engine's page plus the merged ranking
```

Row-level tallies are computed in SQL; the merge-derived ones — how many of an
engine's results reached the caller, how often it was the only engine to find
one — are folded in JS over each stored merged response. Doing that half in
SQL would mean `json_each` across a nested array of arrays for a result no
more correct and much harder to read, and the window is bounded precisely so
that reading it in JS stays cheap. Both halves cover the same window, so every
number in a row describes the same set of searches.

This is a separate interface from `SearchArchive` and `ExtractionArchive` on
purpose. Those are narrow write paths taken during a request; this reads
accumulated history, and anything serving it is exposing a record of what has
been searched for.

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
ids must be stable and unique; callers use them to select a backend. Set the
optional `indexFamily` when the engine is a correlated frontend for another
index; omit it for an independent engine, which then forms its own family.

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

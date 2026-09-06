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

## Status

`core`, `cli`, `api` (which serves both the HTTP API and MCP), and `ui` all
build, typecheck, lint, and have passing tests. The API, MCP tool server, CLI,
and UI are covered at their adapter boundaries; the MCP suite also makes a
real Streamable HTTP request.

The browser layer — persistent Chromium session, page-per-search leases,
two-phase search sessions, and rate limiting — is in place in `core`, along
with the browser-realism layer that makes automated sessions look like
ordinary ones (`stealth`, `human`, `dwell`). Completed fan-outs are also
archived best-effort in a local SQLite database for later analysis.

Four engines ship and are all registered by default: `bing`, `brave`,
`duckduckgo` and `startpage`. Each drives a real browser through its search
engine's homepage the way a person would — typing the query, submitting the
form, and reading the results page — so one unfiltered search fans out to all
four in parallel.

Two of them are largely front ends onto someone else's index, and overlap with
`bing` by design: `startpage` serves mostly Google's results with some of
Bing's, and `duckduckgo` serves mostly Bing's with its own crawl mixed in. What
they add is a different ranking over that corpus — and in Startpage's case,
Google's, which nothing else here reaches. See "Adding a new search engine
backend" to add your own.

Rendered extraction ships too, disabled by default. `POST /extract`, the
`extract` MCP tool, `searchicus extract`, and an Extract action on every UI
result render a page in an isolated browser and return its main content as
Markdown. See "Extraction" below before enabling it.

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
                          │  - engines     │
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

In production `packages/api` also serves the built web UI as static files,
so a single process serves the UI at `/`, the search API at `/api`, and MCP
at `/mcp` — same-origin, with no reverse proxy or CORS setup.

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
  `completed` settles, or until the session cap fires if an engine never
  settles it, which is why short-lived processes must `drain()` before
  exiting.
- **Searches are rate limited as whole fan-outs.** One global throttle gates
  entry to `searchAll()`, so a single query still hits every engine in
  parallel while consecutive searches are spaced apart (5s ±30% by default).
  A search that could not be served with enough of its deadline left to run is
  refused at once with `503` rather than queued: being told after thirty
  seconds that the backends failed, when they were never asked, is the worse
  answer.

Persistent state is rooted at `.searchicus/` **beside this repository**, not
beside whatever directory you happen to be standing in: the root is resolved
from the installed files, so `npm run dev -w @searchicus/api` and a CLI run
from anywhere reach the same archive. (They did not always — resolving from
the working directory gave the API `packages/api/.searchicus` and quietly made
the shared archive two databases.) Each surface gets its own Chromium profile
under `profile/<surface>/`, while `searches.sqlite` is the shared application
archive beside it. Profiles remain isolated because a
user-data directory is single-writer; the archive uses SQLite WAL mode so API
and CLI processes can share it. `SEARCHICUS_DATA_DIR` moves both together;
`SEARCHICUS_PROFILE_DIR` and `SEARCHICUS_STORE_PATH` override one component.

The browser is also configured to behave like one a person is using, since
a search engine that concludes otherwise stops returning useful results.
That lives in three small modules beside the browser session, and engines
opt into them rather than reimplementing any of it:

- **`stealth.ts`** — context options and a single init script, chosen so the
  browser's account of itself has no internal contradictions. The guiding
  rule is that contradictions are what get noticed, not unusual values,
  which is why some things are deliberately _not_ patched: the patch would
  stand out more than the tell it hides. Time zone and locale should match
  where your traffic actually leaves from (`SEARCHICUS_TIMEZONE`).
- **`human.ts`** — jittered pauses, per-character typing, cursor drift. The
  distributions are heavy-tailed on purpose; a flat one is its own signature.
- **`dwell.ts`** — the post-load "read the page" phase. It is handed back as
  `SearchSession.completed`, so it runs _after_ results are returned and
  costs the caller nothing.
- **`click-through.ts`** — after the dwell, clicks an organic result on 40%
  of searches, weighted toward higher ranks. A short decision pause precedes
  the click and a short landing pause follows it; there is no full dwell or
  further interaction on the destination. Any popup opened by that click is
  closed after the landing pause. It uses a real link click so the search
  engine's normal click and referrer behavior are preserved. Result markup is
  engine-specific, so the engine passes the selector for its own result links.

Results are also checked against the query before being believed. A search
engine can answer with HTTP 200, valid markup and real results that have
nothing to do with what was asked — classically, results for only the
query's first term. Nothing about the response looks wrong, so `relevance.ts`
scores how much of the query actually appears in the results and the engine
fails the search rather than returning plausible nonsense. That check, and the
"no organic results" failure, are shared by every engine and live in
`engines/errors.ts`.

## Repository layout

```
searchicus/
├── packages/
│   ├── core/   # types, SearchEngine interface, registry, engines, browser
│   ├── cli/    # `searchicus` command-line tool
│   ├── api/    # HTTP API server + MCP endpoint (Streamable HTTP)
│   └── ui/     # web UI
├── AGENTS.md   # notes for humans and AI coding agents working in this repo
└── README.md
```

## Getting started

Node 22.5 or newer, which is where `node:sqlite` — the search archive's
storage engine — landed.

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

## Running in Docker

One image serves everything. The default command starts the server — web UI at
`/`, search API at `/api`, MCP at `/mcp` — so there's no reverse proxy and no
CORS to configure.

```bash
docker build -t searchicus .

docker run --rm --init --shm-size=1g -p 3000:3000 \
  -v searchicus-data:/data \
  searchicus
```

The CLI is the same image with a different command. It can share that named
volume safely: API and CLI use separate Chromium profile subdirectories while
sharing the archive database through WAL mode.

```bash
docker run --rm --init --shm-size=1g \
  -v searchicus-data:/data \
  searchicus node packages/cli/dist/index.js search "typescript generics"
```

### Flags that aren't optional

| Flag                | Why                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--init`            | Chromium spawns many child processes; with no init process to reap them, zombies accumulate in a container meant to run for days. |
| `--shm-size=1g`     | Docker's default `/dev/shm` is 64MB. Chromium leans on shared memory and dies with opaque renderer crashes without more.          |
| `-v <volume>:/data` | Without it Chromium profiles and the search archive live in the container's writable layer and are discarded on replacement.      |
| `docker stop -t 30` | The server drains live browser sessions for up to 15s; `docker stop` SIGKILLs after 10s by default.                               |

**Use a named volume for the data root, never a host bind mount.** Chromium
profiles are SQLite databases, and SQLite locking over virtiofs/9p — which is
what a macOS or Windows bind mount is — is unreliable. A profile written by
one platform's Chromium also isn't valid for another's.

### Configuration

| Variable                 | Default                             | Effect                                                                   |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------ |
| `PORT`                   | `3000`                              | Port to listen on.                                                       |
| `HOST`                   | `127.0.0.1`; `0.0.0.0` in the image | Address to listen on. Loopback by default: there is no authentication.   |
| `SEARCHICUS_DATA_DIR`    | `/data` in the image                | Persistent-state root: `searches.sqlite` and `profile/<surface>/`.       |
| `SEARCHICUS_PROFILE_DIR` | `<data-dir>/profile/<surface>`      | Chromium user-data directory override. One per process.                  |
| `SEARCHICUS_STORE_PATH`  | `<data-dir>/searches.sqlite`        | Search archive SQLite file override.                                     |
| `SEARCHICUS_STORE`       | enabled                             | Any of `false`/`0`/`no`/`off` disables best-effort archival.             |
| `SEARCHICUS_LOG`         | `info`                              | `debug`, `info`, `warn`, `error` or `silent`. Everything goes to stderr. |
| `SEARCHICUS_TIMEZONE`    | `America/Chicago`                   | IANA time zone the browser reports.                                      |
| `SEARCHICUS_LOCALE`      | `en-US`                             | Locale the browser reports.                                              |
| `SEARCHICUS_EXTRACT_*`   | extraction disabled                 | Rendered extraction; see "Extraction" below.                             |
| `MCP_ENABLED`            | on                                  | Off serves the search API alone; `/mcp` then 404s.                       |
| `SERVE_UI`               | on when a build exists              | `false` skips the static UI.                                             |
| `UI_DIST_DIR`            | `packages/ui/dist`                  | Alternate UI build directory.                                            |

The base image is pinned to the same Playwright version as
`packages/core/package.json` — the bundled Chromium has to be the revision the
client expects, and a mismatch fails at launch rather than at build. Bump both
together.

## Logging

Everything the server reports — the startup banner included — goes to
**stderr**, at a level set by `SEARCHICUS_LOG` (`debug`, `info`, `warn`,
`error`, `silent`; default `info`). stderr rather than stdout so the CLI's
`--json` output stays pipeable into `jq` with logging turned all the way up.

```
2026-09-05T20:56:30.083Z INFO  browser   chromium launched profile=/data/profile/api
2026-09-05T20:56:38.105Z INFO  api       POST /search status=200 ms=8306 bytes=1621
2026-09-05T20:56:42.583Z WARN  extract   extraction failed url=http://127.0.0.1/admin kind=blocked_address cause="…"
2026-09-05T20:56:42.620Z INFO  mcp       tool list_engines engines=4
2026-09-05T20:56:42.635Z WARN  api       POST /search status=400 ms=1 bytes=93
```

One line per request at a level that follows the status, so `warn` leaves a
healthy server quiet and still shows every 4xx and 5xx. Beneath that, the
things that used to fail silently now say so: an engine giving up, a browser
failing to launch, an archive write vanishing, a page the address policy
refused, an extraction failing — the last of these logs the **real** cause,
which the caller deliberately never sees, since a specific enough error
would let someone map internal network space by probing.

**Query text is never logged above `debug`.** It lives in a request body, it
is the sensitive part of this system, and logs get copied and shipped far
more casually than a database file. The same reasoning as the archive warning
below, applied to the other place queries can leak.

## Dashboard

The UI has two dashboard pages beside the search box, both reading the local
archive:

- **Metrics** — totals for the window first: how the fan-outs ended, what was
  read back out of them (with reads served from cache counted separately, so
  the median read time still describes rendering a page), and what this
  process turned away. Then per-engine
  reliability, latency, and, more usefully, what each
  engine actually contributed: how many of its results reached the caller, how
  often it supplied the title shown, how many results **no other engine found**,
  and how many were later extracted. That third number is the one that answers
  whether an engine earns its seconds; an engine that always agrees with the
  others is cheap to drop.
- **History** — every archived search, and for each one what every engine
  returned in its own order, side by side, with the results that survived into
  the merged list highlighted. Refs, per-engine ranks, failure kinds and
  extractions are all there.

Routing is hash-based (`#/metrics`, `#/searches/<id>`), so deep links work
without the server needing a history fallback — which it must not have, since a
catch-all would turn genuine API 404s into HTML.

Both pages need the archive, which is on by default. With
`SEARCHICUS_STORE=false` the endpoints answer `503` and the UI hides the links
rather than offering pages that can only fail.

> **The archive is a record of everything searched for.** These endpoints serve
> that history — queries, result titles, URLs — and the API has no
> authentication. That is fine on a laptop and is not fine on a shared host.
> Put the server behind something, or set `SEARCHICUS_STORE=false`.

## Extraction

Extraction renders a URL and returns its main content as Markdown. It is
available from every front door — `POST /extract`, the `extract` MCP tool,
`searchicus extract <url>`, and an Extract action beside each UI result — and
it is **off until an operator turns it on**.

```bash
SEARCHICUS_EXTRACT_ENABLED=true searchicus extract https://example.com/
```

Pass the `ref` from a search result to tie the extraction to the ranking that
offered it. A ref is provenance, not a label: it must resolve to an archived
result whose URL matches the one being extracted, or the request is refused.
Extracting a bare URL is equally supported, because agents arrive with URLs
from elsewhere.

That correlation is the point. An agent reaching for result 7 is evidence
about results 1 through 6, and the returned list is stored alongside it, so a
ranking can later be judged against what was actually shown. Only metadata is
kept — status, timings, title, domain, sizes, a digest — never page text.

### Read the content as data

The response carries `untrusted: true` and always will. This is arbitrary web
content: it may contain prompt injection, false claims, or hostile links.
Treat it as information to evaluate, never as instructions to follow. The UI
renders it as preformatted text rather than HTML for the same reason.

### Why it is off by default

Rendering caller-supplied URLs means making outbound requests chosen by
whoever can reach the endpoint — the server-side request forgery shape.
searchicus checks the scheme, port, credentials, and every resolved address on
the initial URL and on each redirect hop, refusing loopback, private,
link-local, carrier-grade NAT, unique-local, and metadata ranges.

**Those checks are defense in depth, not the control.** Chromium ultimately
resolves and opens its own connections, so a name that answers publicly and
then privately is not caught by any of it. Before enabling extraction, restrict
the process's outbound network access so it cannot reach anything internal.

### Isolation

Extraction runs in a second, non-persistent browser. It never touches the
search profile's cookies, cache, localStorage, or history, and each extraction
gets a fresh context that is closed on every outcome. `launchPersistentContext`
exposes no `Browser`, so this separation is structural rather than a rule
someone has to remember.

### Configuration

| Variable                                   |     Default | Effect                                        |
| ------------------------------------------ | ----------: | --------------------------------------------- |
| `SEARCHICUS_EXTRACT_ENABLED`               |    disabled | Any of `true`/`1`/`yes`/`on` enables it.      |
| `SEARCHICUS_EXTRACT_MAX_CONCURRENT`        |         `2` | Extractions running at once, per process.     |
| `SEARCHICUS_EXTRACT_MAX_QUEUED`            |        `32` | Callers that may wait for one of those.       |
| `SEARCHICUS_EXTRACT_NAVIGATION_TIMEOUT_MS` |    `10_000` | Deadline through `domcontentloaded`.          |
| `SEARCHICUS_EXTRACT_SETTLE_TIMEOUT_MS`     |     `2_000` | Fixed pause after the DOM is ready.           |
| `SEARCHICUS_EXTRACT_TIMEOUT_MS`            |    `30_000` | End-to-end render, dwell, parse, and respond. |
| `SEARCHICUS_EXTRACT_MAX_BYTES`             | `5_242_880` | Advisory transfer budget; see below.          |
| `SEARCHICUS_EXTRACT_MAX_REDIRECTS`         |         `5` | Redirect-chain cap.                           |
| `SEARCHICUS_EXTRACT_ALLOWED_PORTS`         |    `80,443` | Permitted destination ports.                  |
| `SEARCHICUS_EXTRACT_DWELL`                 |     enabled | Off skips the post-load dwell.                |
| `SEARCHICUS_EXTRACT_CACHE`                 |     enabled | Off re-renders for every window.              |
| `SEARCHICUS_EXTRACT_CACHE_TTL_MS`          |   `300_000` | How long a parsed page may be served.         |
| `SEARCHICUS_EXTRACT_CACHE_MAX_ENTRIES`     |        `32` | Pages held at once.                           |
| `SEARCHICUS_EXTRACT_CACHE_MAX_CHARS`       | `8_000_000` | Total Markdown held, across every entry.      |

Switches read one vocabulary throughout. A switch that is **off** by default
(`SEARCHICUS_EXTRACT_ENABLED`) turns on for `true`, `1`, `yes` or `on` and
stays off for anything else; a switch that is **on** by default
(`SEARCHICUS_STORE`, `SEARCHICUS_EXTRACT_DWELL`, `MCP_ENABLED`, `SERVE_UI`)
turns off for `false`, `0`, `no` or `off` and stays on for anything else.
Case and surrounding spaces do not matter, and an unrecognised value leaves
the switch at its default — which for both directions is the safe one.

`searchicus outline <url>` (and `POST /outline`, and the `outline` MCP tool)
lists a page's sections and the offset to read each, so an agent can see what
a long page contains — and what it does not — before spending context on it.
Sections are addressed by the same offsets `extract` takes, so there is no
second addressing scheme; outlining then reading costs one render, because the
parsed page is already in memory.

A page longer than the budget is read a window at a time: the response says
where the window started and where to continue, and those offsets snap to
**section boundaries** so a window begins at a heading rather than mid-sentence
— and never inside a fenced code block, which is where a naive character cut
lands. `searchicus extract --offset`, the `offset` field on `POST /extract`,
and a "Read on" button in the UI are the same mechanism.

Reading each window would otherwise re-render the page, so a parsed page is
held briefly in memory: measured, the first window of a real page took 5,049ms
and the next three took 1–2ms each. It is bounded three ways — a five-minute
TTL, 32 entries, and 8,000,000 characters in total — because each bound fails
differently on its own, and a page cache without a size bound is a memory leak
with good intentions.

> **This holds page text.** Not on disk and not in the archive, which still has
> nowhere to put it, but in memory for minutes. That is a smaller claim than
> persistence and it is a different one. `SEARCHICUS_EXTRACT_CACHE=false` turns
> it off and costs only time, because paging is correct without it — it has to
> be, since the CLI and the API are separate processes and neither sees the
> other's memory. Entries are keyed by URL and so shared between callers: on a
> shared host a cache hit is visible in the response time, which reveals that
> somebody read that URL. The content is public either way, so what leaks is
> the access pattern rather than the data.

`maxChars` is the one limit a caller controls, since it only bounds the
response (default 20,000, maximum 100,000). The byte budget is advisory: a
chunked response reports no length, so a request-count cap and the end-to-end
deadline are what actually bound the work.

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
Chromium to launch. An engine with no work to do after returning results can
just return a bare `SearchResponse`; the registry normalizes both shapes.

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

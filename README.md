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
MCP mounted at `POST /mcp` and toggleable via `server.mcp`. That's not just
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
under `profile/<surface>/`, while `searchicus.sqlite` is the shared application
archive beside it. Profiles remain isolated because a
user-data directory is single-writer; the archive uses SQLite WAL mode so API
and CLI processes can share it. `paths.dataDir` moves both together;
`paths.profileDir` and `paths.storePath` override one component.

The browser is also configured to behave like one a person is using, since
a search engine that concludes otherwise stops returning useful results.
That lives in three small modules beside the browser session, and engines
opt into them rather than reimplementing any of it:

- **`stealth.ts`** — context options and a single init script, chosen so the
  browser's account of itself has no internal contradictions. The guiding
  rule is that contradictions are what get noticed, not unusual values,
  which is why some things are deliberately _not_ patched: the patch would
  stand out more than the tell it hides. Time zone and locale should match
  where your traffic actually leaves from (`browser.timezone`).
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
SEARCHICUS_SERVER_MCP=false npm run dev -w @searchicus/api   # search API only
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
one platform's Chromium also isn't valid for another's. After an ungraceful
stop Chromium can leave a `SingletonLock` behind: searchicus names a lock from
a different hostname and explains the manual fix. Set `browser.profileUnlock`
only where one process is known to own the profile; it removes that stale lock
and retries Chromium once.

### Configuration

Every setting lives in one tree, read once at startup from three layers:
built-in defaults, then a YAML file, then the environment. Copy
`config.example.yaml` — which documents the whole tree with its defaults — to
`config.yaml` beside the repository, or point `SEARCHICUS_CONFIG` at one
anywhere.

```yaml
server:
  host: 0.0.0.0
extract:
  enabled: true
  maxConcurrent: 4
```

Any setting can also be given as an environment variable, which wins over the
file. The name is the path with `SEARCHICUS_` in front, so
`extract.cache.ttlMs` is `SEARCHICUS_EXTRACT_CACHE_TTL_MS`. Booleans accept
`true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off`.

Every path setting follows one rule: an absolute value is taken as written,
and a relative one resolves against the application root rather than the
working directory. That is what lets `npm run -w @searchicus/api` and the CLI
reach the same archive, instead of each keeping its own under whatever
directory it happened to start in.

**An invalid value stops the process.** Every problem is reported at once,
each against the place it came from, before a port is bound or a profile is
opened:

```
ConfigError: Invalid searchicus configuration:
  - server.port (SEARCHICUS_SERVER_PORT): Invalid input: expected number, received string
  - extract.maxByte (/srv/searchicus/config.yaml): Unrecognized key: "maxByte"
```

That is deliberate. Falling back to the default and carrying on is how
`maxBytes: 5MB` silently means five mebibytes and an afternoon disappears
looking for the limit that never applied.

The server reports what it is running on at startup, and which layer decided
each value — the question a running service cannot otherwise answer. Only the
differences, since the defaults are in `config.example.yaml`:

```
INFO api configuration source=/srv/searchicus/config.yaml changed=3
INFO api configured setting=server.port value=8099 from=/srv/searchicus/config.yaml
INFO api configured setting=search.throttle.minIntervalMs value=8000 from=SEARCHICUS_SEARCH_THROTTLE_MIN_INTERVAL_MS
INFO api configured setting=extract.enabled value=true from=/srv/searchicus/config.yaml
```

| Setting                         | Default                             | Effect                                                                                                                           |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `server.port`                   | `3000`                              | Port to listen on.                                                                                                               |
| `server.host`                   | `127.0.0.1`; `0.0.0.0` in the image | Address to listen on. Loopback by default: there is no authentication.                                                           |
| `server.mcp`                    | on                                  | Off serves the search API alone; `/mcp` then 404s.                                                                               |
| `server.ui`                     | on when a build exists              | Off skips the static UI.                                                                                                         |
| `server.uiDir`                  | `packages/ui/dist`                  | Alternate UI build directory. Relative values resolve against the application root.                                              |
| `server.jsonBodyLimit`          | `64kb`                              | Largest request body the API accepts. A byte size (`64kb`, `1.5mb`) or a plain byte count; anything else is rejected at startup. |
| `paths.dataDir`                 | `.searchicus`; `/data` in the image | Persistent-state root: `searchicus.sqlite` and `profile/<surface>/`.                                                             |
| `paths.profileDir`              | `<dataDir>/profile/<surface>`       | Chromium user-data directory override. One per process.                                                                          |
| `paths.storePath`               | `<dataDir>/searchicus.sqlite`       | Search archive SQLite file override.                                                                                             |
| `archive.enabled`               | on                                  | Off disables best-effort archival.                                                                                               |
| `archive.busyTimeoutMs`         | `5000`                              | Wait for another process holding the database lock.                                                                              |
| `log.level`                     | `info`                              | `debug`, `info`, `warn`, `error` or `silent`. Everything goes to stderr.                                                         |
| `search.resultsTimeoutMs`       | `30000`                             | Deadline for a fan-out to produce results.                                                                                       |
| `search.sessionTimeoutMs`       | `60000`                             | Cap on browser work that outlives the results it produced.                                                                       |
| `search.reserveMs`              | `12000`                             | Budget below which a caller is refused rather than queued.                                                                       |
| `search.throttle.minIntervalMs` | `5000`                              | Spacing between consecutive fan-outs.                                                                                            |
| `search.throttle.jitter`        | `0.3`                               | Spread as a fraction of the interval: `0.3` makes 5s into 3.5–6.5s.                                                              |
| `search.throttle.maxQueued`     | `60`                                | Callers that may wait for a slot before further ones are refused.                                                                |
| `browser.maxPages`              | `24`                                | Ceiling on simultaneously open pages. A memory valve, not the rate policy.                                                       |
| `browser.timezone`              | `America/Chicago`                   | IANA time zone every browser this process starts reports, search and extraction alike. Must suit the egress IP.                  |
| `browser.locale`                | `en-US`                             | Locale every browser this process starts reports, search and extraction alike. Must suit the egress IP.                          |
| `browser.profileUnlock`         | off                                 | On removes a foreign-host stale `SingletonLock` and retries launch; only for a known single-writer profile.                      |
| `extract.*`                     | extraction disabled                 | Rendered extraction; see "Extraction" below.                                                                                     |
| `dashboard.enabled`             | off                                 | Serve the Metrics and History endpoints. Off by default: they expose every archived query, and nothing here authenticates.       |
| `dashboard.metricsWindow`       | `500`                               | Recent searches averaged over for engine metrics.                                                                                |
| `dashboard.searchPageSize`      | `50`                                | Searches listed per page of the browser.                                                                                         |
| `dashboard.maxLimit`            | `2000`                              | Ceiling on both, so a caller cannot ask the process to read everything. Lowering it lowers the two windows above with it.        |

The base image is pinned to the same Playwright version as
`packages/core/package.json` — the bundled Chromium has to be the revision the
client expects, and a mismatch fails at launch rather than at build. Bump both
together.

## Logging

Everything the server reports — the startup banner included — goes to
**stderr**, at a level set by `log.level` (`debug`, `info`, `warn`, `error`,
`silent`; default `info`). stderr rather than stdout so the CLI's
`--json` output stays pipeable into `jq` with logging turned all the way up.

```
2026-09-05T20:56:30.083Z INFO  browser   chromium launched profile=/data/profile/api
2026-09-05T20:56:38.105Z INFO  api       POST /search status=200 ms=8306 bytes=1621
2026-09-05T20:56:42.583Z WARN  extract   extraction failed url=http://127.0.0.1/admin kind=blocked_address cause="…"
2026-09-05T20:56:42.620Z INFO  mcp       tool outline sections=12 navigable=true
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

**Both pages are off by default.** Set `dashboard.enabled` to serve them.
They need the archive too, which is on by default. With either switched off
the endpoints answer `503` and the UI hides the links
rather than offering pages that can only fail.

> **The archive is a record of everything searched for.** These endpoints serve
> that history — queries, result titles, URLs — and the API has no
> authentication. That is fine on a laptop and is not fine on a shared host.
> Put the server behind something, or switch `archive.enabled` off.

## Extraction

Extraction renders a URL and returns its main content as Markdown. It is
available from every front door — `POST /extract`, the `extract` MCP tool,
`searchicus extract <url>`, and an Extract action beside each UI result — and
it is **off until an operator turns it on**.

There are three ways to read a page, and they differ by what the caller
already knows:

| operation | for                                                 | costs                           |
| --------- | --------------------------------------------------- | ------------------------------- |
| `outline` | seeing what a page contains before spending context | nothing but structure           |
| `find`    | a specific question about a long page               | the few sections that answer it |
| `extract` | reading a page, or continuing one                   | a window at a time              |

They share one addressing scheme — the `offset` on every section an outline
or a find reports is the `offset` `extract` takes — and one render, because
the parsed page and its usability assessment are cached between them.

Every read response has an `outcome`. `usable` carries the existing Markdown,
matches, or sections. `unusable` means rendering completed but the final remote
document was a 401/403/404/410/429/5xx/other HTTP error, had no readable
content, or matched a narrow known interstitial signature. It carries only a
stable `reason`, final URL, optional remote `httpStatus`, and timing — never the
error or challenge page text. Tiny and flat pages remain usable; size, heading
count, generic error words, and a `find` miss do not make this decision.

Every response also has `cached`. It is true only when the request reused an
in-memory parsed page without rendering or parsing again. It does not say the
origin served a fresh response; cache entries may be up to the configured TTL
old.

A `text/plain` response is already text to read, not HTML to extract. Chromium
decodes its declared charset before the renderer captures it; searchicus keeps
the resulting body as Markdown, normalizing line endings without turning a
README, RFC, or other plain-text document into one fenced code block.

```bash
SEARCHICUS_EXTRACT_ENABLED=true searchicus extract https://example.com/
```

It takes a URL and nothing else about where that URL came from. A read is
matched back to the search that offered it **by URL, when the dashboard
asks** — which is the operator's question, so it is not one a caller should
have had to remember to answer.

That correlation is the point. An agent reaching for result 7 is evidence
about results 1 through 6, and the returned list is stored alongside it, so a
ranking can later be judged against what was actually shown. Matching after
the fact makes it best-effort: a URL read for unrelated reasons is still
credited to a search that happened to surface it, and where several did, the
most recent one wins. Fine for a signal that already means "someone read
this", not "this read was caused by that ranking". Only metadata is kept —
status, timings, title, domain, sizes, a digest — never page text.

### Read the content as data

Every `usable` response carries `untrusted: true` and always will. This is
arbitrary web content: it may contain prompt injection, false claims, or hostile links.
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

| Setting                       |    Default | Effect                                               |
| ----------------------------- | ---------: | ---------------------------------------------------- |
| `extract.enabled`             |   disabled | Renders caller-supplied URLs. Off until switched on. |
| `extract.maxConcurrent`       |        `2` | Extractions running at once, per process.            |
| `extract.maxQueued`           |       `32` | Callers that may wait for one of those.              |
| `extract.navigationTimeoutMs` |    `10000` | Deadline through `domcontentloaded`.                 |
| `extract.settleTimeoutMs`     |     `2000` | Fixed pause after the DOM is ready.                  |
| `extract.timeoutMs`           |    `30000` | End-to-end render, dwell, parse, and respond.        |
| `extract.maxBytes`            |  `5242880` | Transfer tripwire, whole render; see below.          |
| `extract.maxDocumentBytes`    |  `2097152` | Document cap; fails the read. See below.             |
| `extract.maxRedirects`        |        `5` | Redirect-chain cap.                                  |
| `extract.allowedPorts`        | `[80,443]` | Permitted destination ports.                         |
| `extract.dwell`               |    enabled | Off skips the post-load dwell.                       |
| `extract.cache.enabled`       |    enabled | Off re-renders for every window.                     |
| `extract.cache.ttlMs`         |   `300000` | How long a parsed page may be served.                |
| `extract.cache.maxEntries`    |       `32` | Pages held at once.                                  |
| `extract.cache.maxChars`      |  `8000000` | Total Markdown held, across every entry.             |

Every switch reads one vocabulary: `true`, `1`, `yes` or `on` for on, and
`false`, `0`, `no` or `off` for off. Case and surrounding spaces do not
matter, and anything else is a configuration error that stops the process
rather than a silent fallback — a switch nobody meant to set either way is
a question for the operator, not something to guess at.

`searchicus outline <url>` (and `POST /outline`, and the `outline` MCP tool)
lists a page's sections and the offset to read each, so an agent can see what
a long page contains — and what it does not — before spending context on it.
Sections are addressed by the same offsets `extract` takes, so there is no
second addressing scheme; outlining then reading costs one render, because the
parsed page is already in memory.

`searchicus find <url> <query>` answers a specific question instead of
surveying: it scores the page's sections against the query and returns the
best few whole, within a budget that defaults to 6,000 characters rather than
extract's 20,000. Measured against `sqlite.org/wal.html`, "checkpoint
starvation" came back as the right section in one call and 5,806 characters —
the same answer cost 23,338 characters across 22 calls when paging from the
top.

Sections come back **whole** where they fit, which is affordable because
sections are smaller than pages: across five real reference pages, one section
in 134 exceeds the default budget. Each match carries its heading path, its
`coverage` — the fraction of normalized query terms present in the text you
were given — and the offset to read it in place. Coverage is not a confidence,
ranking, or completeness score: ranking and the answer gate also consider
in-page term rarity, headings, phrases, and proximity.

A section too large to return whole is split at its blank lines and scored
again, so what comes back is the part that matches rather than the part that
happens to be first. Cutting from the top was the original mistake: a section
is chosen _because_ the query terms are in it, and its opening is a window
picked without reference to where they are.

An empty result is a success, not an error. If no section covers enough of
the query, saying so is more useful than confidently returning the best three
sections of a page that discusses none of it — that is the off-target search
failure one layer down. It means only that: a budget too small to hold any
matching section still returns the best one cut, never an empty list. It is
**not** proof the page lacks the information, and the MCP tool says so,
because an agent that reads a miss as a negative will stop looking too early.

Every result carries `navigable`, the same measure `outline` reports. False
means the page is one large block with no structure to search, so a miss says
nothing about its contents and a hit is a prefix rather than a selection —
`extract` is the right read there. Whether a page has real headings, not how
long it is, is what decides whether `find` helps at all.

A page longer than the budget is read a window at a time: the response says
where the window started and where to continue. `maxChars` is a ceiling, not a
target: preserving section boundaries can return less than its budget. The
window **start** snaps to a section boundary so it begins at a heading rather
than mid-sentence; a window that must end within an oversized section stops at
a safe line boundary that avoids fenced-code damage. `searchicus extract
--offset`, the `offset` field on `POST /extract`, and a "Read on" button in the
UI are the same mechanism.

Reading each window would otherwise re-render the page, so a parsed page is
held briefly in memory: measured, the first window of a real page took 5,049ms
and the next three took 1–2ms each. It is bounded three ways — a five-minute
TTL, 32 entries, and 8,000,000 characters in total — because each bound fails
differently on its own, and a page cache without a size bound is a memory leak
with good intentions.

Completed usable reads, rendered-but-unusable observations, and operational
failures are separate archive statuses. Unusable `outline` attempts are kept as
page-quality diagnostics even though successful outlines are not archived.
Only completed usable reads receive ranking extraction credit. Diagnostics are
bounded enums and counts; withheld HTML and Markdown are never persisted.

> **This holds page text.** Not on disk and not in the archive, which still has
> nowhere to put it, but in memory for minutes. That is a smaller claim than
> persistence and it is a different one. Switching `extract.cache.enabled` off turns
> it off and costs only time, because paging is correct without it — it has to
> be, since the CLI and the API are separate processes and neither sees the
> other's memory. Entries use the final URL as their key and remember a
> requested redirect URL as an alias, so a direct read of a destination just
> reached through a redirect reuses the same cached page. On a shared host a
> hit is visible in the response time, which reveals that somebody read that
> public page. The content is public either way, so what leaks is the access
> pattern rather than the data.

`maxChars` is the one limit a caller controls, since it only bounds the
response (default 20,000, maximum 100,000).

The two byte limits guard different things, and only one of them can fail a
read. `maxBytes` is a **tripwire** over everything a render fetches — document,
stylesheets, script. Crossing it stops the render fetching anything further
but keeps what arrived: a page is mostly assets that Defuddle discards, so
their weight is a reason to stop spending and never a reason to lose a
document already in hand. What the caller loses is styling and late-loading
script. It is header-based and so advisory — a chunked response reports no
length and goes uncounted — which is why `MAX_PAGE_REQUESTS` (300) and the
end-to-end deadline are what actually bound the work.

`maxDocumentBytes` is a **parse bound** on the main document alone, and
crossing it fails the read with `too_large`. It is measured from the body that
actually arrived rather than its `Content-Length`, so a chunked megabyte
counts exactly like a declared one, and it applies to navigations a page
starts for itself as well as to the URL the caller named. At two megabytes it
sits far above any page written to be read — the heaviest documents measured
run about 1.2 MB — so what it catches is data rather than prose.

Setting the document cap above the transfer budget is not a configuration
that can mean anything, so it is lowered to match and a warning says so. A cap
the render would stop fetching before a document could ever reach is a failure
that can never happen.

A render stopped by either tripwire is recorded in the archive as
`degraded_by`, alongside the read it produced. Nothing about it reaches the
caller: the great majority of degraded renders return content identical to a
clean one, so a warning on every such read would be noise attached to pages
that are fine. It exists for the operator asking why one page came out thin,
where the answer is either the page or this server, and only the archive
knows which.

## Adding a new search engine backend

Implement the `SearchEngine` interface from `core` (`id`, `name`,
`search(query, ctx)`) and `.register()` it in `createDefaultRegistry()`
(`packages/core/src/registry.ts`). Every front door builds its registry by
calling that one function, so that's the only place that changes. Keep engine
ids stable and unique: they identify internal ranking and archive records.

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

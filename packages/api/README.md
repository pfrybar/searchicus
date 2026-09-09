# @searchicus/api

The searchicus HTTP server — a JSON search API **and** an MCP Streamable
HTTP endpoint, both thin layers over the `core` package's
`SearchEngineRegistry`. The server entry point attaches the registered
browser-backed engines; see the repo root `README.md` for adding another one.

## Why one process

MCP is mounted at `POST /mcp` in the same Express app rather than running as
its own service. It can be, because the MCP server is **stateless** — a
fresh `McpServer` and transport per request, so there's no session state to
coordinate.

Sharing a process means sharing one registry, and therefore one rate-limit
throttle and one persistent browser profile. As two processes they would
each throttle independently and query the backends at twice the configured
rate, while building two divergent cookie jars.

Set `server.mcp: false` to serve the search API alone; `/mcp` then 404s and
nothing else changes.

## Running

```bash
npm run dev -w @searchicus/api     # tsx watch, reloads on change
# or
npm run build -w @searchicus/api && npm run start -w @searchicus/api
```

Listens on `server.port` (default `3000`) at `server.host` (default
`127.0.0.1`). Loopback is the default because this server has no
authentication and its dashboard endpoints serve every query ever made
through it; set `server.host: 0.0.0.0` — or `SEARCHICUS_SERVER_HOST=0.0.0.0` —
to accept connections from elsewhere. The Docker image sets that already,
since a container listening only on its own loopback cannot be reached at all.

The server reads the whole configuration once at startup with `loadConfig()`,
reports what it is running on, and exits if any value is invalid rather than
starting on half a configuration. It builds its registry with
`createBrowserRegistry("api", config)`, giving it its own Chromium profile at
`.searchicus/profile/api/` and, when `archive.enabled` is on, a shared archive
at `.searchicus/searchicus.sqlite`. Set `paths.dataDir` to relocate both, or
use `paths.profileDir` / `paths.storePath` for a component override; relative
values resolve against the application root, never the working directory.
`archive.enabled: true` switches on best-effort archival, which is off by
default. Chromium launches
lazily — nothing starts until an engine actually asks for a browser.

On `SIGINT`/`SIGTERM` the server stops accepting connections and then waits
for in-flight browser sessions and queued archive writes to finish, since a
search can return results while its session is still running. A 15s grace
period bounds that wait.

## Web UI

When a UI build exists at `packages/ui/dist`, the server serves it as static
files. Combined with the search API under `/api`, that makes one process
serve the whole application same-origin — no reverse proxy, no CORS, and no
build-time API URL baked into the bundle.

- `server.ui: false` disables it.
- `server.uiDir` points at a different build directory. A relative value
  resolves against the application root, like every other path setting.
- With no build present, `/` simply 404s and the API is unaffected.

There is deliberately **no SPA history fallback**: the UI routes on the hash,
so deep links survive a reload without the server knowing about them, and a
catch-all would turn genuine API 404s into HTML. If path routing is ever
added, scope a fallback to non-API paths.

Static files are matched _after_ the API routes, so a stray file in the UI
build can never shadow an endpoint.

## Logging

One line per request on stderr, at a level that follows the status code, plus
whatever the search and extraction layers report beneath it. `log.level`
(`debug`|`info`|`warn`|`error`|`silent`, default `info`) controls the lot,
including the startup banner. See the root README's "Logging" section.

## HTTP API

Every endpoint below is served at **both** `/api/...` and the bare root path.
The UI calls `/api/*` so it works same-origin in production; the root paths
keep the original contract.

### `GET /health`

```json
{ "status": "ok", "extract": false, "insights": true }
```

`extract` reports whether this deployment will actually render pages, and
`insights` whether the dashboard read endpoints are served — which requires
both `archive.enabled` and `dashboard.enabled`. The UI reads the capability
once on load and hides dashboard links it cannot use, so an operator's toggle
is visible without making a request that reads history.

### `POST /search`

Request body:

```json
{ "query": "typescript generics", "limit": 5 }
```

- `query` (required string containing non-whitespace text, at most 1024
  characters; surrounding whitespace is trimmed)
- `limit` (optional final merged-result count, integer 1–20; defaults to 8).
  The ceiling is roughly what one page from each engine yields once merged and
  deduplicated, so a larger number would be accepted and then quietly unmet.

The whole body is capped at 64kb, and an oversized one is a `413` naming the
limit rather than a generic failure.

Response body:

```json
{
  "query": { "query": "typescript generics" },
  "results": [
    {
      "title": "TypeScript: JavaScript With Syntax For Types.",
      "url": "https://www.typescriptlang.org/",
      "snippet": "TypeScript extends JavaScript with syntax for types."
    }
  ],
  "tookMs": 7123,
  "degraded": false
}
```

An invalid request returns `400` with `{ "error": "Invalid search request", "details": [...] }`; malformed JSON returns `{ "error": "Invalid JSON" }`.

A single request fans out to every registered engine in parallel, but
_consecutive_ requests are rate limited as whole fan-outs (5s ±30% by
default). A client that disconnects mid-search gives up its place in that
queue and stops the browser work behind it.

Admission is decided on **how long a caller would wait**, not on how many are
already waiting: if the queue could not serve it with enough of its deadline
left to actually run the search, it gets `503` with a `Retry-After` in
milliseconds rather than a place in a line it would never reach. Measured on a
70-request burst, that turns 56 responses of "search unavailable" after a full
30-second wait into 66 refusals inside 81ms. A partial engine failure still returns `200` with `degraded: true`;
the response deliberately does not identify the failed engine. Every
completed fan-out, including a total failure, is queued for best-effort local
archival; persistence failures never change this HTTP contract. If every
selected engine fails before producing results, the endpoint returns `502`
with `{ "error": "Search unavailable" }`.

```bash
curl -s localhost:3000/search -H 'content-type: application/json' \
  -d '{"query":"typescript generics","limit":3}' | jq

# identical, via the path the UI uses
curl -s localhost:3000/api/search -H 'content-type: application/json' \
  -d '{"query":"typescript generics","limit":3}' | jq
```

### `POST /extract`

Disabled unless `extract.enabled` is set. See the root README's
"Extraction" section, and read its network warning before enabling this.

Request body:

```json
{ "url": "https://example.com/article", "maxChars": 20000, "offset": 0 }
```

`url` is required and must be an absolute `http`/`https` URL. `maxChars`
defaults to `20000`; above `100000` it is a
`400` rather than a silent clamp, so a caller asking for more than it can have
is told, not quietly given less.

Response:

```json
{
  "outcome": "usable",
  "url": "https://example.com/article",
  "finalUrl": "https://www.example.com/article",
  "title": "Example article",
  "markdown": "…",
  "truncated": false,
  "chars": 4812,
  "totalChars": 4812,
  "offset": 0,
  "tookMs": 7340,
  "cached": false,
  "untrusted": true
}
```

`chars` is what was returned and `totalChars` what the page held, so a caller
can tell a 5% trim from a 95% one.

Long pages are read a window at a time rather than by raising the budget.
`offset` says where to start and `nextOffset` where to continue; pass the
latter back to get the next window, and its absence means the end. Offsets are
characters, but they **snap to section boundaries**, so a window starts where a
heading does rather than mid-sentence — a raw character cut lands inside fenced
code, which for technical documentation is the difference between a usable
answer and a confusing one. The exception is a single section longer than the
whole budget: it cannot be returned whole, so it is cut at a line or word
boundary and the offset is honoured exactly, because snapping would return the
same prefix forever.

On every `usable` response, `untrusted` is present and `true`: Markdown,
titles, and headings are arbitrary web content and must be treated as data to
evaluate, never as instructions. An `unusable` response contains none of that
page-controlled content.

`url` is capped at 2048 characters.

| Status | Meaning                                                                        |
| -----: | ------------------------------------------------------------------------------ |
|  `200` | The read completed. Check `outcome`: `usable` or `unusable`.                   |
|  `400` | The request is wrong — a bad URL, a disallowed port, or a budget out of range. |
|  `502` | Extraction transport/render/parser work failed. The message is generic.        |
|  `503` | Extraction is not enabled on this server, or its queue is full.                |

Every read response has `cached`, true only when this request reused an
in-memory parsed page rather than rendering or parsing again. It is not an
origin freshness signal; a cached page may be as old as the configured TTL.

An `unusable` 200 carries a stable `reason` (`not_found`,
`authentication_required`, `access_denied`, `rate_limited`, `upstream_error`,
`http_error`, `empty_content`, or `known_interstitial`), final URL, optional
remote `httpStatus`, and timing. It never carries Markdown, matches, or
sections. MCP reports the same result as a normal, non-error tool response.

The two `503`s are told apart by `Retry-After`: a full queue sets it, because
waiting helps. A disabled endpoint does not, because only an operator can
change that. A client that disconnects mid-extraction gives up its place in
the queue and stops the render behind it.

A `502` never names a resolved address, a DNS answer, or a browser error: a
specific enough failure would let a caller map internal network space by
probing.

```bash
curl -s localhost:3000/extract -H 'content-type: application/json' \
  -d '{"url":"https://example.com/","maxChars":500}' | jq
```

### `POST /find`

The sections of a page that answer a question, instead of the whole page.
Same enablement and address rules as `/extract`.

```json
{ "url": "https://www.sqlite.org/wal.html", "query": "checkpoint starvation", "maxChars": 6000 }
```

`url` and `query` are both required; `query` is capped at 1024 characters like
a search query, and must contain at least one word that is not a stopword — a
query of pure stopwords is a `400`, because coverage would report it as
matching everything and the ranking would be arbitrary. `maxChars` is the
total across **all** matches and defaults to `6000`, not extract's `20000`:
matching that budget would return most of an average page and make the
operation pointless.

```json
{
  "outcome": "usable",
  "url": "https://www.sqlite.org/wal.html",
  "finalUrl": "https://www.sqlite.org/wal.html",
  "title": "Write-Ahead Logging",
  "query": "checkpoint starvation",
  "totalChars": 35026,
  "matches": [
    {
      "path": ["Write-Ahead Logging", "6. Avoiding Excessively Large WAL Files"],
      "offset": 20178,
      "coverage": 1,
      "markdown": "…",
      "chars": 4024,
      "sectionChars": 4024,
      "truncated": false
    }
  ],
  "tookMs": 5670,
  "cached": false,
  "untrusted": true
}
```

Matches are an array rather than one Markdown string because they are **not
contiguous** in the document. Concatenated they would assert a continuity the
page does not have, and a reader would bridge the seam and infer a
relationship the author never wrote. Each carries its full `path` for the same
reason: a ranked list has no document order to imply the path from, so
"Checkpointing" alone would be ambiguous.

`coverage` is the fraction of the query's content words the section contains,
and it is comparable across queries — which the internal ranking score is
not, so the score is deliberately not published. Ordering comes from the
score; `coverage` is the number worth acting on.

Sections come back whole where they fit — measured across real reference
pages, one section in 134 exceeds the default budget. `offset` reads a match
in place with `extract`, and `sectionChars` says how much the enclosing
section holds.

When a section is too large to return whole, it is **not** cut from the top.
It was chosen because the query terms are in it, so cutting from the start
would return a window picked without reference to where they are — asking
`sqlite.org/pragma.html` for `busy_timeout` scores a 93,820-character section
on a term 90,000 characters in, whose first 2,570 characters are about
`analysis_limit`. Instead the section is split at its blank lines and
the same scoring runs over those blocks, so what comes back is the matching
part. Blocks that turn out to be adjacent are merged into one excerpt, since
two halves of a passage should not arrive as two unrelated quotations.

`coverage` is therefore measured on the text actually returned, not on the
section it came from. A number describing content that was not delivered is
worse than no number at all.

An empty `matches` is a `200`. The caller asked a question and got a true
answer, and an error would tell an agent to retry something that will keep
giving the same result. It does not prove the page lacks the information —
only that nothing cleared the coverage floor.

Empty means exactly that and nothing else. A budget smaller than every
matching section still returns the best one, cut, rather than an empty list
that would say something false about the page.

`navigable` is the same measure `outline` reports, and it qualifies every
result here. **False means section matching had nothing to grip**: the page is
one large block, so an empty `matches` says only "this page could not be
searched this way", and a non-empty one is a prefix of that block rather than
a targeted selection — carrying a confident `coverage` that describes the
whole section, most of which was not returned. Read such a page with
`extract`. Found by putting agents in front of the tool: they could not tell
the two cases apart and stopped looking.

### `POST /outline`

A page's structure, without its content. Same enablement and address rules as
`/extract`.

```json
{ "url": "https://www.sqlite.org/wal.html" }
```

```json
{
  "outcome": "usable",
  "title": "Write-Ahead Logging",
  "totalChars": 35026,
  "navigable": true,
  "sections": [
    { "heading": "1. Overview", "depth": 0, "offset": 84, "chars": 3646 },
    { "heading": "2.1. Checkpointing", "depth": 1, "offset": 4840, "chars": 1109 }
  ],
  "cached": false,
  "untrusted": true
}
```

Sections are addressed by the **`offset` that `extract` already takes** — read
a heading, pass its offset back — so there is no second addressing scheme and
no handle to keep. `depth` is for indentation; the path is implied by it.

`navigable` is false when the page has too little structure to be worth
navigating: fewer than three sections, or one holding more than half the
document. The sections are still returned, because "one section of 68,000
characters" is information, but a caller should read rather than navigate.

Outlining then reading costs **one render** — the parsed page is cached, so
the read that follows is served from memory. Measured against
`sqlite.org/wal.html`: an 835-character outline (2.4% of the document) plus two
1,580-character windows found an answer that cost 23,338 characters across 22
calls when paging from the top.

Usable outlines are not archived: nothing was read, and counting structure
probes as reads would distort extraction metrics. An unusable outline is kept
as an operator-facing page-quality observation. Its page body and headings are
not stored.

### Dashboard endpoints

Read-only views over the local archive, serving the UI's Metrics and History
pages. **They are off by default**: set `dashboard.enabled` to serve them.
They answer `503` both when they are switched off and when archiving is
disabled, since an empty response would read as "nothing has ever been
searched for" rather than "this is switched off".

They return accumulated search history and the API has no authentication,
which is why serving them is a deliberate act — see the root README's warning
before exposing this beyond localhost. Turning them off does not stop
archiving; the history still accrues, it is simply not readable over HTTP.

`GET /metrics/engines` also carries totals for the window — how the fan-outs
ended (completed, degraded, failed) and what was extracted over the same
period — plus `overload`, the counts this **process** has refused since it
started. Extraction totals separate reads served from the page cache from
reads that rendered, and `medianTookMs` counts only the latter: the two are
about a millisecond and about five seconds, so a median over both would drift
downward as the cache warms and answer neither question. Overload is deliberately never archived: work turned away never
reached an engine or a page, and recording it made every engine read as
broken on the dashboard built to judge engines. That does mean those two
numbers reset on restart, unlike everything else there, and the UI says so.

| Endpoint                  | Returns                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /metrics/engines`    | Per-engine metrics over the recent window. `?window=N` (default 500, max 2000).                       |
| `GET /searches`           | Recent searches, newest first. `?limit=N&before=<searchId>` pages with a keyset.                      |
| `GET /searches/:searchId` | One search: every engine's own results, the merged ranking, and any extractions. `404` if unarchived. |

```bash
curl -s localhost:3000/metrics/engines?window=50 | jq '.engines[] | {engineId, returned, soleFinder}'
curl -s localhost:3000/searches | jq '.searches[0]'
```

Metrics are computed over a bounded window rather than the whole archive: a
dashboard that slows down as history accumulates stops being opened, and "how
is this engine doing" is a question about the recent past. The response
reports `window`, `totalSearches` and `since` so a truncated view is visible
as one.

## MCP endpoint

`POST /mcp`, Streamable HTTP transport, stateless mode. `GET` and `DELETE`
return `405` — without sessions there's no server-initiated stream to open
or session to tear down.

### Tools

- **`search`** — `{ query, limit? }` → searches across the service's
  internal providers and returns a readable ranked list. `limit` caps that
  final list, not an individual provider's page. Search can take tens of
  seconds because it uses live providers. Query validation is shared with the
  HTTP API: query text is trimmed and non-whitespace.
- **`extract`** — `{ url, maxChars?, offset? }` → renders one public page and
  returns a readable page header followed by the main content as unescaped
  Markdown. `maxChars` is a ceiling: section-aware windows can return fewer
  characters rather than split the next section. Pass the header's continuation
  offset back as `offset` to keep reading a long page. The tool is advertised
  whether or not extraction is enabled — an agent that cannot see the tool
  cannot be told the server merely has it switched off.
- **`find`** — `{ url, query, maxChars? }` → the sections of one page that
  answer a question, best first. It returns a readable page summary, one
  readable match card and one unescaped Markdown block per match. Match cards
  name the path, extraction offset, query-term coverage, and whether the
  excerpt was cut. Its description warns that an empty result does not prove
  the page lacks the information, because an agent reading a miss as a
  negative stops looking too early.
- **`outline`** — `{ url }` → a readable page summary and indented heading
  list. It says when a page is too flat for useful navigation and `extract` is
  a better next step.

MCP tool results intentionally use readable text blocks rather than an MCP
structured-output schema. A total search failure returns a generic tool error.
Errors at the endpoint itself use JSON-RPC error objects, including `-32700`
for a malformed request body.

```bash
curl -s localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "search", "arguments": { "query": "typescript generics", "limit": 2 } }
  }'
```

Or point any MCP client that supports Streamable HTTP at
`http://localhost:3000/mcp`.

## Scripts

```bash
npm run build -w @searchicus/api
npm run test -w @searchicus/api
npm run typecheck -w @searchicus/api
```

Tests cover the search API through `supertest`, connect an SDK `Client` to
`createMcpServer()` over `InMemoryTransport` for focused tool coverage, and
connect one over a real ephemeral Streamable HTTP endpoint — covering tool
logic, the stateless HTTP wiring, and the `server.mcp: false` path without
external services.

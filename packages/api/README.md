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

Set `MCP_ENABLED=false` to serve the search API alone; `/mcp` then 404s and
nothing else changes.

## Running

```bash
npm run dev -w @searchicus/api     # tsx watch, reloads on change
# or
npm run build -w @searchicus/api && npm run start -w @searchicus/api
```

Listens on `PORT` (default `3000`).

The server builds its registry with `createBrowserRegistry("api")`, giving it
its own Chromium profile at `.searchicus/profile/api/` and a shared archive at
`.searchicus/searches.sqlite`. Set `SEARCHICUS_DATA_DIR` to relocate both, or
use `SEARCHICUS_PROFILE_DIR` / `SEARCHICUS_STORE_PATH` for a component
override. `SEARCHICUS_STORE=false` disables best-effort archival. Chromium
launches lazily — nothing starts until an engine actually asks for a browser.

On `SIGINT`/`SIGTERM` the server stops accepting connections and then waits
for in-flight browser sessions and queued archive writes to finish, since a
search can return results while its session is still running. A 15s grace
period bounds that wait.

## Web UI

When a UI build exists at `packages/ui/dist`, the server serves it as static
files. Combined with the search API under `/api`, that makes one process
serve the whole application same-origin — no reverse proxy, no CORS, and no
build-time API URL baked into the bundle.

- `SERVE_UI=false` disables it.
- `UI_DIST_DIR` points at a different build directory.
- With no build present, `/` simply 404s and the API is unaffected.

There is deliberately **no SPA history fallback**: the UI is a single page
with no client-side router, and a catch-all would turn genuine API 404s into
HTML. If routing is added later, scope a fallback to non-API paths.

Static files are matched _after_ the API routes, so a stray file in the UI
build can never shadow an endpoint.

## HTTP API

Every endpoint below is served at **both** `/api/...` and the bare root path.
The UI calls `/api/*` so it works same-origin in production; the root paths
keep the original contract.

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /engines`

```json
[
  { "id": "bing", "name": "Bing" },
  { "id": "brave", "name": "Brave" },
  { "id": "duckduckgo", "name": "DuckDuckGo" },
  { "id": "startpage", "name": "Startpage" }
]
```

### `POST /search`

Request body:

```json
{ "query": "typescript generics", "limit": 5, "engines": ["bing", "brave"] }
```

- `query` (required string containing non-whitespace text; surrounding
  whitespace is trimmed)
- `limit` (optional final merged-result count, integer 1–100; defaults to 8)
- `engines` (optional non-empty, duplicate-free array of engine-id strings;
  defaults to every registered engine)

Response body:

```json
{
  "searchId": "00m2ebw9mbyib",
  "query": { "query": "typescript generics" },
  "results": [
    {
      "ref": "00m2ebw9mbyib-1",
      "title": "TypeScript: JavaScript With Syntax For Types.",
      "url": "https://www.typescriptlang.org/",
      "score": 0.0325,
      "bestSource": "bing",
      "found": [
        { "engineId": "bing", "rank": 1 },
        { "engineId": "brave", "rank": 2 }
      ],
      "families": ["bing", "brave"]
    }
  ],
  "tookMs": 7123,
  "degraded": false
}
```

An invalid request returns `400` with `{ "error": "Invalid search request", "details": [...] }`; malformed JSON returns `{ "error": "Invalid JSON" }`. Naming an engine that isn't registered is a `400` too, with the unknown id in `details` — a caller's typo is not a backend failure, and `GET /engines` already lists every valid id.

A single request fans out to every selected engine in parallel, but
_consecutive_ requests are rate limited as whole fan-outs (5s ±30% by
default). A partial engine failure still returns `200` with `degraded: true`;
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

## MCP endpoint

`POST /mcp`, Streamable HTTP transport, stateless mode. `GET` and `DELETE`
return `405` — without sessions there's no server-initiated stream to open
or session to tear down.

### Tools

- **`search`** — `{ query, limit?, engines? }` → fans the
  query out across the requested (or every) registered engine, merges the
  results, and returns one attributed ranked list. `limit` caps that final
  list, not an individual engine's page. Query and engine-selection validation
  is shared with the HTTP API: query text is
  trimmed and non-whitespace, and a supplied `engines` list is non-empty and
  duplicate-free.
- **`list_engines`** — lists the engines currently registered.

Partial engine failure sets `degraded: true` on the merged result without
naming the engine. A total engine failure returns a generic tool error, while
an unregistered engine id returns a tool error naming it, so an agent that
mistyped an id from `list_engines` can correct itself. Errors at the endpoint
itself use JSON-RPC error objects, including `-32700` for a malformed request
body.

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
logic, the stateless HTTP wiring, and the `MCP_ENABLED=false` path without
external services.

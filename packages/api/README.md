# @searchicus/api

The searchicus HTTP API — a thin JSON layer over the `core` package's
`SearchEngineRegistry`. Only the mock engine ships registered; see the repo
root `README.md` for adding a browser-backed one.

## Running

```bash
npm run dev -w @searchicus/api     # tsx watch, reloads on change
# or
npm run build -w @searchicus/api && npm run start -w @searchicus/api
```

Listens on `PORT` (default `3000`).

The server builds its registry with `createBrowserRegistry("api")`, giving it
its own Chromium profile at `.searchicus/profile/api/` (override with
`SEARCHICUS_PROFILE_DIR`). Chromium launches lazily — nothing starts until an
engine actually asks for a browser.

On `SIGINT`/`SIGTERM` the server stops accepting connections and then waits
for in-flight browser sessions to finish, since a search can return results
while its session is still running. A 15s grace period bounds that wait.

## Endpoints

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /engines`

```json
[{ "id": "mock", "name": "Mock Search Engine" }]
```

### `POST /search`

Request body:

```json
{ "query": "typescript generics", "limit": 5, "engines": ["mock"] }
```

- `query` (required string containing non-whitespace text; surrounding
  whitespace is trimmed)
- `limit` (optional integer, 1–100; defaults to each engine's own default)
- `page` (optional positive integer)
- `filters` (optional string→string map)
- `engines` (optional non-empty, duplicate-free array of engine-id strings;
  defaults to every registered engine)

Response body:

```json
{
  "query": { "query": "typescript generics", "limit": 5 },
  "outcomes": [{ "engineId": "mock", "ok": true, "response": { "...": "..." } }]
}
```

An invalid request returns `400` with `{ "error": "Invalid search request", "details": [...] }`; malformed JSON returns `{ "error": "Invalid JSON" }`.

A single request fans out to every selected engine in parallel, but
_consecutive_ requests are rate limited as whole fan-outs (5s ±30% by
default). A request that waits out its budget without getting a slot still
returns `200`, with every engine reporting `ok: false` — engine-level
failures are outcomes, not HTTP errors.

```bash
curl -s localhost:3000/search -H 'content-type: application/json' \
  -d '{"query":"typescript generics","limit":3}' | jq
```

## Scripts

```bash
npm run build -w @searchicus/api
npm run test -w @searchicus/api
npm run typecheck -w @searchicus/api
```

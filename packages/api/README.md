# @searchicus/api

The searchicus HTTP API — a thin JSON layer over the `core` package's
`SearchEngineRegistry`. Currently searches against the mock engine only;
see the repo root `README.md`/`AGENTS.md` for how real backends will plug
in later.

## Running

```bash
npm run dev -w @searchicus/api     # tsx watch, reloads on change
# or
npm run build -w @searchicus/api && npm run start -w @searchicus/api
```

Listens on `PORT` (default `3000`).

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

- `query` (required, non-empty string)
- `limit` (optional, 1–100, defaults to each engine's own default)
- `page` (optional)
- `filters` (optional, string→string map)
- `engines` (optional array of engine ids; defaults to every registered engine)

Response body:

```json
{
  "query": { "query": "typescript generics", "limit": 5 },
  "outcomes": [{ "engineId": "mock", "ok": true, "response": { "...": "..." } }]
}
```

An invalid body returns `400` with `{ "error": "...", "details": [...] }`.

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

# @searchicus/mcp

An MCP server exposing the search registry as tools, served over the MCP
**Streamable HTTP** transport (stateless mode — no session state between
requests; see `src/app.ts` for why that's the right default here).

## Tools

- **`search`** — `{ query, limit?, page?, filters?, engines? }` → fans the
  query out across the requested (or every) registered engine. Query and
  engine-selection validation is shared with the HTTP API: query text is
  trimmed and non-whitespace, and a supplied `engines` list is non-empty and
  duplicate-free.
- **`list_engines`** — lists the engines currently registered.

Both are backed by the same `core` `SearchEngineRegistry` the CLI and HTTP
API use; only the mock engine is registered for now (see AGENTS.md).

## Running

```bash
npm run dev -w @searchicus/mcp     # tsx watch, reloads on change
# or
npm run build -w @searchicus/mcp && npm run start -w @searchicus/mcp
```

Listens on `PORT` (default `3001`), MCP endpoint at `POST /mcp`.

```bash
curl -s localhost:3001/mcp \
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
`http://localhost:3001/mcp`.

## Scripts

```bash
npm run build -w @searchicus/mcp
npm run test -w @searchicus/mcp
npm run typecheck -w @searchicus/mcp
```

Tests connect an SDK `Client` to `createMcpServer()` over
`InMemoryTransport` for focused tool coverage and also connect one over a
real ephemeral Streamable HTTP endpoint. That covers both the tool logic and
the stateless HTTP wiring without external services.

# @searchicus/ui

A small web UI over the HTTP API: a search page, and two dashboard pages over
the local archive.

## Pages

| Route             | Shows                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| `#/`              | Search, with Outline, Find, and Extract actions on each result when page reading is on. |
| `#/metrics`       | Per-engine reliability, latency, and what each engine contributed.                      |
| `#/searches`      | Archived searches, newest first.                                                        |
| `#/searches/<id>` | One search: every engine's own results side by side, plus the ranking.                  |

Routing is hash-based and hand-rolled in `router.ts` — no router dependency.
The API and this UI share one origin and one Express app, so real paths would
need a history fallback there, and `app.ts` explains why a catch-all is a trap:
it turns genuine API 404s into HTML. A hash keeps deep links working with no
server change, which for a local dashboard is all routing has to do.

The shell reads `GET /api/health` once on load and hides what the deployment
cannot do — the page-reading actions without `SEARCHICUS_EXTRACT_ENABLED`,
the dashboard links without an archive. A control that can only fail is worse
than no control.

Extracted page content is rendered as preformatted text, never as HTML: it is
Markdown a stranger's website wrote. Every read checks the shared
`usable | unusable` outcome first; usable reads mark page-derived content as
untrusted, including outline titles and headings. Unusable pages show a warning
with a stable reason and remote status instead of rendering an access wall or
error body.
The dashboard reports unusable observations separately from completed reads
and infrastructure failures.

## Running

```bash
npm run dev -w @searchicus/api   # in one terminal — the API this UI talks to
npm run dev -w @searchicus/ui    # in another — Vite dev server on :5173
```

The dev server proxies `/api/*` to the API at `http://localhost:3000` (see
`vite.config.ts`), so no CORS setup is needed locally. The API serves those
same paths under `/api`, so the proxy does no path rewriting and dev and
production hit identical URLs.

**In production the API serves this build itself**, same-origin, so there is
normally nothing to configure: build the UI, and `@searchicus/api` picks up
`dist/` automatically. That's what makes `VITE_API_URL` unnecessary — it is
inlined at _build_ time, so baking it would tie the artifact to one
environment. Set it only when deploying the UI somewhere the API isn't, in
which case the two origins differ and CORS has to be configured at the API's
reverse proxy; the API does not enable cross-origin requests by default.

```bash
npm run build -w @searchicus/ui     # typecheck + production build to dist/
npm run preview -w @searchicus/ui   # serve that build locally

# or let the API serve it, the way production does:
npm run build -w @searchicus/ui && npm run start -w @searchicus/api
```

## Scripts

```bash
npm run build -w @searchicus/ui
npm run test -w @searchicus/ui
npm run typecheck -w @searchicus/ui
```

Component tests use `@testing-library/react` with `fetch` mocked directly —
no MSW or real network calls.

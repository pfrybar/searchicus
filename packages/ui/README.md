# @searchicus/ui

A minimal web UI: a search box that calls the HTTP API and renders results
grouped by engine.

## Running

```bash
npm run dev -w @searchicus/api   # in one terminal — the API this UI talks to
npm run dev -w @searchicus/ui    # in another — Vite dev server on :5173
```

The dev server proxies `/api/*` to the API at `http://localhost:3000` (see
`vite.config.ts`), so no CORS setup is needed locally. For a standalone
build, set `VITE_API_URL` to the deployed API URL. If the UI and API use
different origins, configure CORS at the API's reverse proxy (or serve them
through one origin); this API intentionally does not enable cross-origin
requests by default.

```bash
npm run build -w @searchicus/ui     # typecheck + production build to dist/
npm run preview -w @searchicus/ui   # serve that build locally
```

## Scripts

```bash
npm run build -w @searchicus/ui
npm run test -w @searchicus/ui
npm run typecheck -w @searchicus/ui
```

Component tests use `@testing-library/react` with `fetch` mocked directly —
no MSW or real network calls.

# @searchicus/ui

A minimal web UI: a search box that calls the HTTP API and renders results
grouped by engine.

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

# @searchicus/ui

A small web UI over the HTTP API: a search page, and two dashboard pages over
the local archive.

## Pages

| Route             | Shows                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `#/?q=…`          | Search. The query lives in the URL, so a result can be pasted or reloaded. |
| `#/metrics`       | Per-engine reliability, latency, and what each engine contributed.         |
| `#/searches`      | Archived searches, newest first.                                           |
| `#/searches/<id>` | One search: every engine's own results side by side, plus the ranking.     |

Routing is hash-based and hand-rolled in `router.ts` — no router dependency.
Submitting a search writes `#/?q=my+query`, and opening a URL that carries one
runs it: a search link that does not search is a broken link. Submitting the
same query twice re-runs it, since the hash has not changed and nothing else
would tell the two apart.
The API and this UI share one origin and one Express app, so real paths would
need a history fallback there, and `app.ts` explains why a catch-all is a trap:
it turns genuine API 404s into HTML. A hash keeps deep links working with no
server change, which for a local dashboard is all routing has to do.

The shell reads `GET /api/health` once on load and hides the dashboard links
when `dashboard.enabled` is off, or when there is no archive to read — both
of which are the default. The section nav goes with them, since one section
is not a nav. A control that can only fail is worse than no control.

**This UI does not read pages.** Outline, find and extract are API and MCP
capabilities; the search page lists results and links out to them. The
dashboard still reports what was read through those other front doors,
keeping unusable observations separate from completed reads and from
infrastructure failures.

## Look and theme

Every colour resolves to a custom property declared in `index.css`, so the
dark theme is one block of redefinitions rather than a second stylesheet. The
theme follows the operating system through `prefers-color-scheme`; there is no
in-app switch, because a local dashboard that disagrees with the desktop it
sits on is a setting to maintain rather than a feature.

The palette is taken from the logo: the wordmark's navy, the blue of its last
four letters, and the teal at the top of the mark.

## Brand assets

`src/assets/` holds the masthead lockup, derived from the full-resolution
master by cropping to the ink, scaling to 600px wide, and lifting the white
background into an alpha channel so it sits on either theme. The dark variant
differs in one respect: the wordmark's navy is remapped to a light slate,
because navy on a dark background is invisible. Everything else — the mark's
blues and teals, the blue of "icus" — is the same in both.

`public/` holds the icons, which keep their exact paths in the build the API
serves (`/favicon.ico`, `/apple-touch-icon.png`, `/site.webmanifest`). The
generated `favicon.svg` is deliberately not shipped: it is a 550px raster
wrapped in an `<svg>`, so it is six times the weight of the 96px PNG and no
sharper anywhere.

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

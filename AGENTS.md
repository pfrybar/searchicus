# AGENTS.md

Notes for anyone (human or AI coding agent) working in this repository.

## What this is

`searchicus` is a search proxy: one query in, results from multiple backend
search engines out. It's a TypeScript npm-workspaces monorepo with a shared
`core` package and four front doors: a CLI, an HTTP API, an MCP server
(Streamable HTTP transport), and a web UI. The HTTP API and MCP server share
one process and one package (`packages/api`). See `README.md` for the
architecture picture.

Backend engines drive a real headless browser. `core` owns a single
long-lived Chromium instance (Playwright `launchPersistentContext`) and
hands each search a page from it; engines parse results out of that page.
The `bing`, `brave`, `duckduckgo` and `startpage` engines are all registered
by default and drive the real sites, so an unfiltered search fans out to all of
them. Tests inject deterministic test doubles where they need browser-free
adapter coverage.

## Repo layout

```
packages/
  core/   shared types + SearchEngine interface + registry + engines
          + browser session (Playwright) + rate-limit throttle
          + browser realism (stealth/human/dwell/click-through) + relevance gate
  cli/    `searchicus` CLI (commander)
  api/    HTTP API (express) + MCP endpoint at /mcp, mounted from src/mcp/
  ui/     web UI (vite + react)
```

Each package is independently versioned/built under `packages/*`. Internal
packages currently declare the matching `0.1.0` version of `@searchicus/core`;
npm workspaces resolves that compatible dependency to the local workspace, so
no publishing is required for local development. Keep those versions aligned
if a package version changes.

## Conventions

- **Language**: TypeScript everywhere, `strict` mode on. Compiled output
  goes to each package's `dist/`, which is git-ignored.
- **Module format**: ESM (`"type": "module"`) across all packages.
- **Package manager**: npm (workspaces). Don't add a lockfile from another
  package manager (pnpm/yarn) — `package-lock.json` at the repo root is the
  single source of truth for installed versions.
- **Shared config**: `tsconfig.base.json` at the repo root holds common
  compiler options; each package's `tsconfig.json` extends it.
- **Naming**: package directories are the unscoped feature name
  (`packages/cli`, not `packages/searchicus-cli`); npm package names are
  scoped as `@searchicus/<name>`.

## Common commands

Run from the repo root unless noted otherwise.

```bash
npm install         # install everything
npm run build       # build all packages; dependent package hooks build core first
npm run test         # build core as needed, then run all Vitest suites
npm run lint         # eslint across the repo
npm run format       # prettier --write
npm run typecheck    # build core declarations as needed, then tsc --noEmit
```

Browser-backed tests skip automatically when Chromium can't launch (a slim
container usually lacks `libnss3`/`libgbm`/`libX11`, and
`playwright install-deps` needs root). They are the only coverage of the real
Playwright wiring, so run them somewhere with a working browser before
trusting changes to `browser.ts`.

`npm run dev` starts the API, MCP server, and UI dev servers together
(via `concurrently`); each is also runnable on its own:

```bash
npm run dev -w @searchicus/api   # HTTP API + MCP with reload, :3000 (MCP at /mcp)
npm run dev -w @searchicus/ui    # Vite dev server, :5173 (proxies /api to :3000)
npm run build -w @searchicus/cli && node packages/cli/dist/index.js search "query"
```

## Working style expected in this repo

- Prefer small, focused commits that each leave the repo in a working
  state (installs, builds, and — once tests exist — passes them).
- When adding a package, give it its own `package.json`, `tsconfig.json`,
  and a short `README.md` describing what it does and how to run it.
- Keep the `SearchEngine` interface in `core` minimal and stable; the CLI,
  API, and MCP server should each be a thin adapter over
  `SearchEngineRegistry`, not reimplement search logic themselves.
- Engines are registered once, in core's `createDefaultRegistry()`
  (`packages/core/src/registry.ts`) — every front door defaults to calling
  it rather than building its own registry. Add a new engine there, not per
  package. An engine's optional `indexFamily` names a correlated underlying
  corpus for merged ranking (DuckDuckGo shares Bing's family); omit it for an
  independent engine. It's a factory (fresh instance per call), not a shared
  singleton, so `createApp`/`createProgram`/`createMcpServer` can keep accepting an
  injectable `registry` parameter for tests.
- **Playwright must never reach core's main entry.** `createDefaultRegistry()`
  has no browser attached on purpose; `browser.ts` is published separately as
  `@searchicus/core/browser` and only entry points import it. The UI
  type-imports from core, so a value import of Playwright there would drag
  browser binaries into a Vite bundle. The registry depends on the
  `BrowserProvider` interface, never on the `BrowserSession` class.
  `human.ts`, `dwell.ts`, `click-through.ts` and `relevance.ts` import
  Playwright for **types only**, which is why an engine in the main entry may
  use them; `stealth.ts` reads the browser binary with `node:child_process`
  and so is reachable only from `browser.ts`. Check with: import
  `core/dist/index.js` and confirm nothing matching `playwright` lands in the
  module cache.
- **Browser identity lives in `stealth.ts`, not in engines.** Context options
  and one init script, applied by `createDefaultBrowserSession()`. The
  init script is installed inside the launch path, so it survives a crash
  relaunch; `launchOptions` may be a factory, resolved on first launch, so
  values that require asking the binary about itself (the UA has to name the
  version the binary actually is) don't break the rule that an engine which
  never calls `acquireBrowser()` starts no browser. `channel: "chromium"` is
  load-bearing — Playwright's default headless is a different, much barer
  binary. Timezone and locale must stay plausible for the egress IP;
  `SEARCHICUS_TIMEZONE` / `SEARCHICUS_LOCALE` override them.
- **Click through only after dwelling.** `click-through.ts` runs after the
  passive SERP dwell, considers only organic linked results, and samples 40%
  of searches with a weighted preference for higher ranks. Its decision and
  landing pauses are deliberately lighter than `extractDwell()`. A popup must
  be scoped to its originating SERP page and closed after that landing pause;
  click-through must stay best-effort and never turn ready results into a
  failed search.
- **Parse with `textContent`, not `innerText`, and guard every read with
  `count()`.** Both were learned from the live site. `innerText` is a
  function of CSS, and a real SERP hid an organic result's heading with a
  style rule, so `innerText` returned `""` and the parser discarded a good
  result. And Playwright's text/attribute readers _auto-wait_: reading a
  field that isn't there blocks for the full default timeout (30s) before any
  `catch` runs, which is enough to exhaust the registry's whole results
  budget. `count()` never waits. Both rules live in `engines/parse.ts` now —
  use `readText`/`readCollapsed`/`readSnippet` rather than calling
  `textContent` directly. `textContent` has one cost they handle: it also
  returns the text of `<style>` and `<script>` nodes, so a site that parks
  styles inline (Startpage does, mid-hydration) yields titles with CSS in
  them. Reaching for `innerText` to fix that brings the hiding problem back —
  and note the trigger is `visibility:hidden`, not `display:none`, which
  `innerText` falls back to `textContent` for (pinned in parse.test.ts).
- **Auto-wait bites on input too, not just reads.** `pressSequentially` waits
  with Playwright's 30s default, so a renamed search box used to burn the
  registry's whole results budget and fail with a raw locator timeout. The
  flow confirms the box first and bounds typing, raising
  `SearchBoxUnavailableError` in ~5s naming the engine.
- **The interaction is shared; the selectors are not.** `engines/flow.ts`
  owns the sequence every engine performs (homepage, type, submit, wait,
  parse, relevance-gate, then dwell and click-through as `completed`) and
  `engines/parse.ts` owns how a field is read. An engine supplies only a
  `BrowserSearchSpec`: its homepage, its selectors and its own parser. Put
  behaviour in the flow and site knowledge in the engine — the selectors are
  the part that rots, and each site rots differently.
- **Hand back a union of search-box candidates, never `.first()` of one.** A
  comma selector is matched in _document order_, not in the order its
  alternatives are written, so `.first()` means "whichever is first in the
  DOM", not "the preferred one". Startpage's homepage puts four
  `<input type="hidden" name="query">` ahead of its real `#q`. The flow
  filters to visible before choosing; an engine that narrows first defeats it.
- **Result markup belongs to the engine.** Each engine owns its own selectors
  and passes them to anything shared — `clickThroughResult` takes the engine's
  `linkSelector` because Bing links from `h2 a` and Brave has no heading
  element at all, and a wrong selector there fails silently rather than
  loudly. Prefer selectors the site
  means (ids, `data-*`, semantic class fragments) over ones its build emits:
  Brave's UI is compiled from Svelte and every styled element carries a hash
  like `svelte-jmfu5f` that changes whenever they ship CSS. Where a site mixes
  units into one class, name the organic one positively (`data-type="web"`)
  instead of enumerating what to exclude, so a new unit type is ignored by
  default rather than returned as a result. Check what an _ad_ looks like
  before trusting a selector: DuckDuckGo's ads are siblings of its organic
  results carrying the identical title-link test id, separated only by the
  parent's `data-layout`, so selecting on the link returns paid placements as
  search results — output that looks entirely plausible and is wrong.
- **Content-level failures are shared.** `NoResultsError` and
  `OffTargetResultsError` live in `engines/errors.ts` and carry the engine
  name; don't redeclare them per engine, or core's star exports collide.
- **Check that results answer the query that was asked.** `relevance.ts`
  scores token coverage, because a search engine can return HTTP 200 with
  valid markup and real results that are answers to a different question —
  classically, only the query's first term. Nothing about the transport looks
  wrong, so it has to be caught from the content.
- **Results and sessions are separate signals.** `search()` resolving means
  results are ready; the returned `SearchSession.completed` settling means
  the browser work is done. An engine may return results and keep using its
  page. The registry releases the browser lease when `completed` settles, so
  an engine that never settles it leaks a page into a browser that is meant
  to run for days. Engines with nothing to do afterwards just return a bare
  `SearchResponse` and the registry normalizes it.
- **Anything short-lived must `drain()` before exiting.** Sessions outlive the
  call that started them, so exiting as soon as results arrive kills live
  browser work. The CLI `close()`s in a `finally`; the servers drain on
  SIGINT/SIGTERM with a grace period.
- **Rate limiting is the registry's job, not each engine's.** One global
  throttle gates entry to `searchAll()`, so a single incoming search still
  fans out to every engine in parallel while _consecutive_ searches are
  spaced apart (5s ±30% jitter by default). Tests that run searches back to
  back should pass `{ throttle: null }`.
- **One browser, one context, a page per search — deliberately no pool.** A
  pool would isolate concurrent searches; sharing one persistent context is
  what carries cookies, dismissed consent banners, and cache across searches
  and across restarts. Each surface gets its own profile directory because a
  Chromium user-data dir is single-writer and `npm run dev` starts the API
  and MCP server together.
- **MCP is mounted, not a separate service.** `createMcpRouter` is stateless
  (a fresh `McpServer` per request), so it mounts as an ordinary router in
  the API app and is toggled with `createApp(registry, { mcp })` /
  `MCP_ENABLED`. Keep it mounted _before_ the catch-all 404, which would
  otherwise swallow every MCP request, and keep MCP failures in JSON-RPC
  error shape — body-parse errors reach the shared error middleware, not the
  MCP router, so that branch has to stay.
- **The search router is mounted twice**, at `/` and `/api`, so the UI can
  call `/api/*` same-origin in production while the original root contract
  keeps working. Static UI files are mounted after those routes (a build
  must never shadow an endpoint) and before the 404. There is no SPA history
  fallback on purpose — it would turn API 404s into HTML, and the UI has no
  client-side router.
- Validate untrusted requests through the shared core schemas. `SearchQuery`
  is the engine input; `SearchRequest` adds the optional engine selection for
  API/MCP callers. Do not recover `engines` by casting raw request bodies.
- If you touch the plugin interface or shared request schemas, update every
  adapter (CLI/API/MCP/UI) that assumes their current shape, plus their tests
  and package README files.
- **The Dockerfile pins the Playwright base image to the `playwright`
  version in `packages/core/package.json`.** The image's bundled Chromium
  must match the client revision; bump both together or it fails at launch.
  `.dockerignore` must keep excluding `node_modules` — this repo is developed
  from a macOS bind mount, so the host tree can hold the wrong platform's
  native binaries.
- Consumers import core's built ESM entry point. Their `prebuild`, `predev`,
  `pretest`, and `pretypecheck` hooks deliberately build core first, so keep
  those hooks when changing package scripts or adding another core consumer.

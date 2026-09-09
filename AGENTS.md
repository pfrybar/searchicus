# AGENTS.md

Agent-facing guidance for working in this repository. `README.md` explains the
product and its public behavior; this file records the commands, boundaries,
and invariants needed to change it safely.

## Project overview

`searchicus` is a TypeScript npm-workspaces monorepo. One query fans out to
multiple browser-driven search engines and returns a merged result list. It has
four public surfaces:

- `packages/core` — shared types, schemas, engine registry, browser sessions,
  ranking, SQLite archive, extraction, and diagnostics
- `packages/cli` — the `searchicus` command-line interface
- `packages/api` — Express HTTP API and Streamable HTTP MCP endpoint at `/mcp`
- `packages/ui` — Vite/React search and archive dashboard

Bing, Brave, DuckDuckGo, and Startpage are registered by default in
`createDefaultRegistry()`. The API and MCP endpoint deliberately share one
process, registry, throttle, browser profile, and archive connection.

Search and extraction use different browsers. Search uses one long-lived
persistent Chromium context so cookies and cache survive. Extraction renders
caller-supplied URLs in a separate non-persistent browser with a fresh context
per read and must never reach the search profile.

## Setup and common commands

Requires Node 24 or newer and npm. Run commands from the repository root.

```bash
npm install
npm run build
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run format          # writes formatting changes
```

Run development servers:

```bash
npm run dev                         # API/MCP :3000 and UI :5173
npm run dev -w @searchicus/api      # API and MCP only
npm run dev -w @searchicus/ui       # UI only; proxies /api to :3000
```

Run the built CLI:

```bash
npm run build -w @searchicus/cli
node packages/cli/dist/index.js search "query"
```

Browser-backed tests skip when Chromium or its system libraries cannot launch.
A green suite with skips does not validate real Playwright wiring. Before
trusting changes to `browser.ts`, `browser/session.ts`, or
`browser/extract-browser.ts`, run the affected tests with working Chromium.

## Code and workspace conventions

- Package source is strict TypeScript and ESM. JavaScript/MJS is used only for
  repository tooling and configuration.
- Use npm workspaces and the root `package-lock.json`. Do not add pnpm or Yarn
  lockfiles.
- Build output belongs in package `dist/` directories and is not committed.
- Package directories are unscoped (`packages/core`); package names are scoped
  (`@searchicus/core`).
- Keep workspace versions aligned. Internal consumers currently depend on
  `@searchicus/core` version `0.1.0`.
- Preserve consumer `prebuild`, `pretest`, `pretypecheck`, and package-specific
  `predev` hooks that build core before importing its compiled ESM output.
- New packages need their own `package.json`, `tsconfig.json`, and concise
  `README.md`.
- Validate untrusted HTTP and MCP input with the shared Zod schemas in core.
  `SearchQuery` is engine input; `SearchRequest` adds the merged-result limit.
  Do not recover request fields by casting raw bodies.
- Log through `packages/core/src/logger.ts`, never directly with `console` in
  application code. Logs go to stderr so CLI stdout remains pipeable. Query
  text stays at `debug` or below.
- Read configuration from the tree in `packages/core/src/config.ts`, never
  from `process.env`. A front door calls `loadConfig()` once and passes slices
  down; nothing beneath one reads the environment for itself. The logger's own
  bootstrap level is the single exception, because the loader logs.
- A new setting is one leaf added to `DEFAULT_CONFIG_INPUT` and the schema,
  documented in `config.example.yaml` and the README table. Its environment
  name is derived from its path, so do not write one by hand. Tests fail if
  the example file omits it.
- Operator values only. Tuned algorithm constants stay in the module that owns
  them, and so do caller-facing bounds wired into the request schemas or MCP
  tool descriptions.
- A path setting is resolved with `resolveApplicationPath()`, never used raw
  and never resolved against the working directory: `npm run -w` would give
  each package its own state. A setting that bounds another is applied where
  the tree is finalized, so the value the process reports is the one in force.
- When a shared type, schema, or plugin contract changes, update every affected
  adapter, test, and package README in the same change.

## Module boundaries

- Keep `SearchEngine` small. CLI, API, and MCP are adapters over
  `SearchEngineRegistry`; they must not reproduce search logic.
- Register engines once in `createDefaultRegistry()`. It is a factory, not a
  singleton, so tests and front doors can inject or modify registries safely.
- `createDefaultRegistry()` is browser-free. Playwright must not become
  reachable from core's main entry point.
- Playwright-backed code is exported through `@searchicus/core/browser`.
  Browser-adjacent modules imported by the main entry may use Playwright types
  only.
- The UI imports `canonicalizeUrl` from `@searchicus/core/ranking`, not the
  core root, so Vite does not pull in the SQLite archive or Node built-ins.
- After changing these boundaries, build core and verify importing
  `core/dist/index.js` does not load a module whose path contains
  `playwright`.

## Search-engine rules

- One browser, one persistent context, and one page per engine run is
  deliberate; do not introduce a browser pool. Independently running surfaces use separate
  profile directories because Chromium profiles are single-writer. API and MCP
  share the API process and profile.
- Browser identity belongs in `browser/stealth.ts`, not in individual engines.
  Preserve `channel: "chromium"`; locale and timezone must remain plausible
  for the egress IP.
- Shared interaction belongs in `engines/flow.ts`; site-specific selectors and
  result parsing belong in each engine. Selector decay is engine-specific.
- Use `engines/parse.ts` helpers. Read with `textContent`, not `innerText`, and
  call `count()` before text or attribute reads to avoid Playwright auto-waiting
  for missing fields.
- Treat typing as bounded input work too. Confirm a visible search-box candidate
  before `pressSequentially`; return all candidates rather than calling
  `.first()` on a comma selector.
- Select organic result containers positively. Do not infer that a title link
  is organic: DuckDuckGo ads intentionally resemble normal results.
- Pass engine-specific result link selectors to click-through behavior. Shared
  code must not guess site markup.
- Dwell before click-through. Click-through remains best-effort and must never
  turn already parsed results into a failed search.
- Shared content failures live in `engines/errors.ts`. Relevance checks belong
  in the shared flow rather than individual engines.
- Tokenize relevance and retrieval text with the shared ICU-based logic. Do not
  replace it with ASCII character-class splitting; that breaks non-Latin and
  unspaced languages.
- An engine may return results before its browser work finishes.
  `SearchSession.completed` is the later session-lifetime signal. The registry
  owns lease cleanup and its hard cap; short-lived callers must drain or close
  before exiting.
- Rate limiting belongs to the registry and gates a whole fan-out, not each
  engine. Tests that run searches back-to-back should use `{ throttle: null }`.
- Set `indexFamily` for correlated corpora so ranking counts one family vote;
  DuckDuckGo shares Bing's family. Omit it for independent engines.

## Extraction and security

Read the root README's **Extraction** section before changing or enabling this
feature.

- Extraction is disabled by default. It renders arbitrary caller-selected
  URLs, so application address checks are defense in depth; operator-enforced
  outbound network restrictions are the actual SSRF control.
- Extraction must stay structurally isolated from the persistent search
  profile. Do not share its browser, context, cookies, cache, localStorage, or
  history.
- Keep `outline`, `find`, and `extract` as separate operations. A flag that
  changes response shape is a hidden mode. They share one Markdown offset
  scheme, `splitSections`, and one page cache.
- Every successful read returns an `outcome`. `usable` may carry page-derived
  content; `unusable` carries safe metadata only. Classify final HTTP status
  before parsing, then reject empty content or narrow known interstitial
  signatures. Do not reject a page merely for being short, flat, or having a
  zero parser word count when it contains meaningful symbols.
- Treat all page-derived titles, headings, snippets, and Markdown as untrusted
  data. Usable responses expose `untrusted: true`; front doors must preserve a
  visible trust boundary.
- Cache parsed pages and stable usability outcomes so outline/find/extract can
  share one render. Do not cache transient rate-limit or upstream-server
  outcomes.
- Extraction uses a total transfer tripwire and a separate main-document cap.
  The tripwire degrades a render; only the document cap fails it. Preserve that
  distinction and archive `degradedBy` rather than warning every caller.
- Archive extraction metadata only, never HTML or Markdown. `completed`,
  `unusable`, and `failed` are distinct outcomes. Only completed usable reads
  receive extraction-interest credit. Successful outlines are not reads;
  unusable outlines may be retained as page-quality diagnostics.

## API, MCP, and UI routing

- Mount MCP before the catch-all 404. It uses a fresh stateless `McpServer` per
  request and must keep JSON-RPC error shapes, including body-parser failures.
- Mount search/read routes at both `/` and `/api`. The UI uses `/api` in
  production while the root paths remain public API compatibility routes.
- Serve built UI files after API routes and before the JSON 404 so static files
  cannot shadow endpoints.
- The UI uses hash routing. Do not add an Express history fallback; it would
  turn genuine API 404s into HTML.

## Testing expectations

- Add or update focused tests for changed behavior, including failure and
  boundary cases. Do not rely only on broad suites.
- Before committing, run the relevant focused tests and, when practical,
  `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`, and
  `npm run format:check`.
- If a browser-backed test skips, report it explicitly. Run it in an environment
  with Chromium before treating browser lifecycle or request-policy work as
  fully validated.
- The Dockerfile Playwright image version must match the `playwright` version in
  `packages/core/package.json`. Update both together; `.github/workflows/ci.yml`
  fails the build when they drift.
- Keep `.dockerignore` excluding `node_modules`; host-mounted dependencies may
  contain binaries for the wrong platform.
- CI runs the same five scripts on every push and pull request, installs real
  Chromium, and launches a browser before the suite so a broken install fails
  the job rather than skipping 78 of core's tests. It also builds the image.

## Releasing

The image is published to `ghcr.io/pfrybar/searchicus` by
`.github/workflows/ci.yml`, for `linux/amd64` and `linux/arm64`, after the
checks and tests pass. A push to `main` publishes `main` and `sha-<commit>`;
a `v*.*.*` tag publishes the version, its `major.minor`, and `latest`.
Pull requests build the image and publish nothing.

To release, bump every version, then tag:

```bash
npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
# Then update the exact `@searchicus/core` pins in packages/api and
# packages/cli by hand: npm version does not move them, and npm install
# would go to the public registry for a private package and 404.
npm install                     # refresh package-lock.json
npm run build && npm test       # the bump is a change like any other
git commit -am "Release 0.2.0"
git tag v0.2.0
git push --follow-tags
```

CI refuses a tag whose name does not match the root `package.json` version,
and refuses any commit whose workspace pins disagree with core's version, so
neither mistake reaches the registry.

The GHCR package starts private. Making it public is a one-time change in the
package settings on GitHub, not something the workflow can do.

## Commit instructions

- Keep commits small, focused, and working. Do not include unrelated local or
  generated files.
- Match the established message style: keep subject and body lines at 72
  characters or fewer and hard-wrap prose paragraphs.
- End AI-authored commits with a `Co-Authored-By` footer naming the actual model
  used and its provider-appropriate noreply address. Do not copy a stale model
  name from another commit.

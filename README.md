# searchicus

A search proxy: send one query out to multiple backend search engines and get
back a unified set of results. Searchicus is built as a small TypeScript
monorepo with a shared core, and several front doors onto that core:

- **CLI** — run searches from a terminal
- **HTTP API** — a JSON API for programmatic access
- **MCP server** — a Model Context Protocol server (Streamable HTTP
  transport) so AI agents/tools can search through it, served from the same
  process as the HTTP API
- **Web UI** — a minimal browser UI for interactive search

The set of backend search engines is **pluggable**: every engine implements
one small interface and is registered with the core registry. Engines run
against a real headless browser — core keeps a single long-lived Chromium
instance with a persistent profile and hands each search a page from it.

## Status

`core`, `cli`, `api`, `mcp`, and `ui` all build, typecheck, lint, and have
passing tests. The API, MCP tool server, CLI, and UI are covered at their
adapter boundaries; the MCP suite also makes a real Streamable HTTP request.

The browser layer — persistent Chromium session, page-per-search leases,
two-phase search sessions, and rate limiting — is in place in `core`, along
with the browser-realism layer that makes automated sessions look like
ordinary ones (`stealth`, `human`, `dwell`).

The `bing` engine drives a real browser through the Bing homepage the way a
person would — typing the query, submitting the form, and reading the results
page. See "Adding a new
search engine backend" to add your own.

## Architecture

```
                          ┌────────────────┐
                          │  core package  │
                          │  - types       │
                          │  - engine      │
                          │    interface   │
                          │  - registry    │
                          │  - throttle    │
                          │  - browser     │
                          │    session     │
                          │  - engines     │
                          └───────┬────────┘
                                  │
             ┌────────────────┼────────────────┐
             │                │                │
        ┌─────────┐   ┌───────────────┐   ┌─────────┐
        │   cli   │   │      api      │   │   ui    │
        │ command │   │  HTTP  +  MCP │   │ browser │
        │  line   │   │  JSON     /mcp│   │   app   │
        └─────────┘   └───────────────┘   └─────────┘
```

All of the search-facing surfaces (CLI, HTTP API, MCP server) are thin
adapters over the `core` package's `SearchEngineRegistry`. The web UI talks
to the HTTP API.

In production `packages/api` also serves the built web UI as static files,
so a single process serves the UI at `/`, the search API at `/api`, and MCP
at `/mcp` — same-origin, with no reverse proxy or CORS setup.

The HTTP API and the MCP server share **one process** (`packages/api`), with
MCP mounted at `POST /mcp` and toggleable via `MCP_ENABLED`. That's not just
packaging convenience: sharing a process means sharing one registry, and
therefore one rate-limit throttle and one persistent browser profile. Run as
two processes they would throttle independently and query the backends at
twice the configured rate.

### The browser layer

Core runs **one** long-lived Chromium instance with **one** persistent
browser context, handing each search its own page. There is deliberately no
browser pool: a pool would isolate concurrent searches, but sharing a single
persistent context is what carries cookies, dismissed consent banners, and
cache across searches — and, because the profile lives on disk, across
process restarts too.

Two consequences shape the API:

- **Results and sessions are separate.** `search()` resolving means results
  are ready; the `SearchSession.completed` promise settling means the browser
  work is finished. An engine can return results immediately and keep paging
  or following links afterwards. The registry holds the browser lease until
  `completed` settles, which is why short-lived processes must `drain()`
  before exiting.
- **Searches are rate limited as whole fan-outs.** One global throttle gates
  entry to `searchAll()`, so a single query still hits every engine in
  parallel while consecutive searches are spaced apart (5s ±30% by default).

Each surface gets its own Chromium profile under `.searchicus/profile/`
(override with `SEARCHICUS_PROFILE_DIR`), because a user-data directory is
single-writer and `npm run dev` runs the API and MCP server side by side.

The browser is also configured to behave like one a person is using, since
a search engine that concludes otherwise stops returning useful results.
That lives in three small modules beside the browser session, and engines
opt into them rather than reimplementing any of it:

- **`stealth.ts`** — context options and a single init script, chosen so the
  browser's account of itself has no internal contradictions. The guiding
  rule is that contradictions are what get noticed, not unusual values,
  which is why some things are deliberately _not_ patched: the patch would
  stand out more than the tell it hides. Time zone and locale should match
  where your traffic actually leaves from (`SEARCHICUS_TIMEZONE`).
- **`human.ts`** — jittered pauses, per-character typing, cursor drift. The
  distributions are heavy-tailed on purpose; a flat one is its own signature.
- **`dwell.ts`** — the post-load "read the page" phase. It is handed back as
  `SearchSession.completed`, so it runs _after_ results are returned and
  costs the caller nothing.

Results are also checked against the query before being believed. A search
engine can answer with HTTP 200, valid markup and real results that have
nothing to do with what was asked — classically, results for only the
query's first term. Nothing about the response looks wrong, so `relevance.ts`
scores how much of the query actually appears in the results and the engine
fails the search rather than returning plausible nonsense.

## Repository layout

```
searchicus/
├── packages/
│   ├── core/   # types, SearchEngine interface, registry, engines, browser
│   ├── cli/    # `searchicus` command-line tool
│   ├── api/    # HTTP API server + MCP endpoint (Streamable HTTP)
│   └── ui/     # web UI
├── AGENTS.md   # notes for humans and AI coding agents working in this repo
└── README.md
```

## Getting started

```bash
npm install
npm run build   # builds every package (core first — the others depend on it)
```

Run the API, MCP server, and UI dev servers together:

```bash
npm run dev
```

That starts the HTTP API on `:3000` — with the MCP endpoint at
`:3000/mcp` — and the Vite dev server (UI) on `:5173`, wired together (the
UI dev server proxies `/api/*` to the HTTP API). Or run either on its own —
see each package's README (`packages/{core,cli,api,ui}/README.md`) for
details:

```bash
npm run dev -w @searchicus/api
MCP_ENABLED=false npm run dev -w @searchicus/api   # search API only
npm run dev -w @searchicus/ui

# CLI (no long-running server — build once, then invoke it directly)
npm run build -w @searchicus/cli
node packages/cli/dist/index.js search "typescript generics"
```

Other useful root-level scripts (each runs across every package):

```bash
npm test           # builds core as needed, then runs Vitest per package
npm run typecheck  # builds core declarations as needed, then runs tsc --noEmit
npm run lint       # eslint .
npm run format     # prettier --write .
```

## Running in Docker

One image serves everything. The default command starts the server — web UI at
`/`, search API at `/api`, MCP at `/mcp` — so there's no reverse proxy and no
CORS to configure.

```bash
docker build -t searchicus .

docker run --rm --init --shm-size=1g -p 3000:3000 \
  -v searchicus-api-profile:/profiles/api \
  searchicus
```

The CLI is the same image with a different command, and needs its own profile
volume (a Chromium user-data directory is single-writer, so it cannot share
the server's):

```bash
docker run --rm --init --shm-size=1g \
  -e SEARCHICUS_PROFILE_DIR=/profiles/cli \
  -v searchicus-cli-profile:/profiles/cli \
  searchicus node packages/cli/dist/index.js search "typescript generics"
```

### Flags that aren't optional

| Flag                        | Why                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--init`                    | Chromium spawns many child processes; with no init process to reap them, zombies accumulate in a container meant to run for days.                                 |
| `--shm-size=1g`             | Docker's default `/dev/shm` is 64MB. Chromium leans on shared memory and dies with opaque renderer crashes without more.                                          |
| `-v <volume>:/profiles/...` | Without it the Chromium profile lives in the container's writable layer and is discarded on exit — silently degrading to a cold profile every run, with no error. |
| `docker stop -t 30`         | The server drains live browser sessions for up to 15s; `docker stop` SIGKILLs after 10s by default.                                                               |

**Use a named volume for the profile, never a host bind mount.** Chromium
profiles are SQLite databases, and SQLite locking over virtiofs/9p — which is
what a macOS or Windows bind mount is — is unreliable. A profile written by
one platform's Chromium also isn't valid for another's.

### Configuration

| Variable                 | Default                      | Effect                                                 |
| ------------------------ | ---------------------------- | ------------------------------------------------------ |
| `PORT`                   | `3000`                       | Port to listen on.                                     |
| `SEARCHICUS_PROFILE_DIR` | `/profiles/api` in the image | Chromium user-data directory. One per process.         |
| `SEARCHICUS_TIMEZONE`    | `America/Chicago`            | IANA time zone the browser reports.                    |
| `SEARCHICUS_LOCALE`      | `en-US`                      | Locale the browser reports.                            |
| `MCP_ENABLED`            | on                           | `false` serves the search API alone; `/mcp` then 404s. |
| `SERVE_UI`               | on when a build exists       | `false` skips the static UI.                           |
| `UI_DIST_DIR`            | `packages/ui/dist`           | Alternate UI build directory.                          |

The base image is pinned to the same Playwright version as
`packages/core/package.json` — the bundled Chromium has to be the revision the
client expects, and a mismatch fails at launch rather than at build. Bump both
together.

## Adding a new search engine backend

Implement the `SearchEngine` interface from `core` (`id`, `name`,
`search(query, ctx)`) and `.register()` it in `createDefaultRegistry()`
(`packages/core/src/registry.ts`). Every front door builds its registry by
calling that one function, so that's the only place that changes. Keep
engine ids stable and unique — callers select them in the API, MCP tool, and
CLI.

```ts
class ExampleEngine implements SearchEngine {
  readonly id = "example";
  readonly name = "Example";

  async search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    const { page } = await ctx.acquireBrowser();
    await page.goto(`https://example.com/search?q=${encodeURIComponent(query.query)}`);
    const results = await parseResults(page);

    return {
      response: { query, results, engine: this.id, tookMs: 0 },
      // Results are ready now; this settles when the page work is done.
      completed: prefetchNextPage(page),
    };
  }
}
```

`ctx.acquireBrowser()` is lazy — an engine that never calls it never causes
Chromium to launch. An engine with no work to do after returning results can
just return a bare `SearchResponse`; the registry normalizes both shapes.

Running a browser-backed engine needs Playwright's Chromium **and** its
system libraries:

```bash
npx playwright install chromium
sudo npx playwright install-deps   # needs root; slim containers lack these
```

Without them the browser-backed tests skip and browser-backed engines fail
with a `BrowserUnavailableError` explaining what's missing.

## License

MIT — see [LICENSE](./LICENSE).

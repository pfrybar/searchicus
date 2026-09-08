# @searchicus/cli

The `searchicus` command-line interface — a thin adapter over the `core`
package's `SearchEngineRegistry`. It uses the registered browser-backed
engines; see the repo root `README.md` for adding another one.

The CLI builds its registry with `createBrowserRegistry("cli")`, so it gets
its own Chromium profile at `.searchicus/profile/cli/` and shares the local
archive at `.searchicus/searches.sqlite` with other surfaces. Set
`SEARCHICUS_DATA_DIR` to relocate both, or `SEARCHICUS_PROFILE_DIR` /
`SEARCHICUS_STORE_PATH` to override one component; `SEARCHICUS_STORE=false`
disables archival. Because a search can return results while its browser
session is still running, the CLI drains sessions and queued archive writes
before exiting rather than killing them mid-flight — so the process may stay
alive briefly after printing results.

## Usage

```bash
npm run build -w @searchicus/cli

node packages/cli/dist/index.js search "typescript generics" --limit 3
node packages/cli/dist/index.js search "typescript generics" --json
```

Once published/linked, the same binary is available as `searchicus`
(see the `bin` field in `package.json`).

### `search <query>`

| Option            | Description                                |
| ----------------- | ------------------------------------------ |
| `-l, --limit <n>` | Final results (`1`–`20`, default `8`)      |
| `--json`          | Print raw JSON instead of a formatted list |

The query is trimmed and must contain non-whitespace text. `--limit` caps the
final merged list, never an individual engine's normal first-page results.
Invalid limits or queries make the command exit non-zero before any provider
is called. Text output is a compact title, URL, and snippet list; `--json`
returns the same generic response.

Rate limiting is in-memory, so it does **not** survive across invocations: a
shell loop calling the CLI repeatedly gets no spacing between searches.

### `extract <url>`

Renders a page and prints its main content as Markdown. Disabled unless
`SEARCHICUS_EXTRACT_ENABLED=true`; read the root README's "Extraction" section
before enabling it. A completed render that is an HTTP error, empty document,
or known interstitial prints `Page content unavailable` and its stable reason,
with exit status 0; `--json` exposes the common `outcome: "unusable"` branch
without returning the remote error-page text. `find` and `outline` use the same
classification.

```bash
SEARCHICUS_EXTRACT_ENABLED=true searchicus extract https://example.com/
searchicus extract https://example.com/ --max-chars 500
searchicus extract https://example.com/ --json
```

| Option             | Effect                                                         |
| ------------------ | -------------------------------------------------------------- |
| `-m, --max-chars`  | Markdown budget, 1–100000. Defaults to 20000.                  |
| `-o, --offset <n>` | Start reading here. Use the `--offset` a previous run printed. |
| `--json`           | Print the raw response instead of formatted Markdown.          |

Text output prints the title, final URL, and size, then a line marking
where our output stops and the page's own untrusted text begins. When a page
is longer than the budget it also prints the `--offset` to pass back for the
next window, which starts at the next section rather than mid-sentence.

### `find <url> <query>`

Returns only the sections of a page that answer a question, best first.

```bash
searchicus find https://www.sqlite.org/wal.html "checkpoint starvation"
searchicus find https://www.sqlite.org/wal.html "checkpoint starvation" --max-chars 1500
```

```
Write-Ahead Logging
https://www.sqlite.org/wal.html
3 matches, 5806 of 35026 chars in 5670ms — untrusted page content follows

[1] 6. Avoiding Excessively Large WAL Files
    100% coverage · 4024 chars · read in place with --offset 20178

## 6. Avoiding Excessively Large WAL Files
…
```

| Option            | Effect                                                 |
| ----------------- | ------------------------------------------------------ |
| `-m, --max-chars` | Total characters across all matches. Defaults to 6000. |
| `--json`          | Print the raw response instead of formatted Markdown.  |

Each match is headed separately because they are not contiguous in the page:
run together they would read as continuous prose and invite joining two
passages the document never put side by side. `coverage` is how much of the
query that section contains, and `--offset` reads it in place with `extract`.

When nothing covers the query the command says so rather than returning the
least-bad sections — and it distinguishes "no section covered this" from
"this page has no sections to search", which are the same empty list and
completely different answers. A page with too little structure is called out
on hits too, since a match there is the top of one large block.

### `outline <url>`

Lists a page's sections, with the `--offset` to read each one.

```bash
searchicus outline https://www.sqlite.org/wal.html
searchicus extract https://www.sqlite.org/wal.html --offset 20178
```

```
 offset   chars  section
      0      84  (untitled)
     84    3646  1. Overview
   3730    1110  2. How WAL Works
   4840    1109    2.1. Checkpointing
```

Takes `--json` for the raw response. The second command costs no render: the
page is still in memory from the first.

### `paths`

Prints where this machine keeps its Chromium profile and search archive, with
`--json` for machine-readable output. Useful because those locations resolve
from the application root and the environment, so "which archive am I looking
at" is otherwise a question you can only answer by guessing.

## Scripts

```bash
npm run build -w @searchicus/cli
npm run test -w @searchicus/cli
npm run typecheck -w @searchicus/cli
```

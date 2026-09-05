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
node packages/cli/dist/index.js engines
```

Once published/linked, the same binary is available as `searchicus`
(see the `bin` field in `package.json`).

### `search <query>`

| Option                 | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `-e, --engine <id...>` | Engine id(s) to search; defaults to every registered engine |
| `-l, --limit <n>`      | Final merged results (`1`–`20`, default `8`)                |
| `--json`               | Print raw JSON instead of a formatted list                  |

The query is trimmed and must contain non-whitespace text. `--limit` caps the
final merged list, never an individual engine's normal first-page results.
Invalid limits, queries, or engine selections (including duplicate ids) make
the command exit non-zero before any engine is called. Text output includes a
result ref and engine attribution; `--json` returns the same merged response.

Rate limiting is in-memory, so it does **not** survive across invocations: a
shell loop calling the CLI repeatedly gets no spacing between searches.

### `extract <url>`

Renders a page and prints its main content as Markdown. Disabled unless
`SEARCHICUS_EXTRACT_ENABLED=true`; read the root README's "Extraction" section
before enabling it.

```bash
SEARCHICUS_EXTRACT_ENABLED=true searchicus extract https://example.com/

# tie the read back to the search that offered it
searchicus extract "https://example.com/a" --ref 00m2ebw9mbyib-3

searchicus extract https://example.com/ --max-chars 500
searchicus extract https://example.com/ --json
```

| Option            | Effect                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `-r, --ref <ref>` | Result ref from an earlier search. Must match the URL being read. |
| `-m, --max-chars` | Markdown budget, 1–100000. Defaults to 20000.                     |
| `--json`          | Print the raw response instead of formatted Markdown.             |

Text output prints the title, final URL, ref, and size, then a line marking
where our output stops and the page's own untrusted text begins.

### `paths`

Prints where this machine keeps its Chromium profile and search archive, with
`--json` for machine-readable output. Useful because those locations resolve
from the application root and the environment, so "which archive am I looking
at" is otherwise a question you can only answer by guessing.

### `engines`

Lists the engines currently registered, with `--json` for machine-readable output.

## Scripts

```bash
npm run build -w @searchicus/cli
npm run test -w @searchicus/cli
npm run typecheck -w @searchicus/cli
```

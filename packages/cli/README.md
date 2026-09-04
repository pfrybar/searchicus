# @searchicus/cli

The `searchicus` command-line interface — a thin adapter over the `core`
package's `SearchEngineRegistry`. It uses the registered browser-backed
engines; see the repo root `README.md` for adding another one.

The CLI builds its registry with `createBrowserRegistry("cli")`, so it gets
its own Chromium profile at `.searchicus/profile/cli/`. Because a search can
return results while its browser session is still running, the CLI drains
those sessions before exiting rather than killing them mid-flight — so the
process may stay alive briefly after printing results.

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
| `-l, --limit <n>`      | Final merged results (`1`–`100`, default `8`)               |
| `--json`               | Print raw JSON instead of a formatted list                  |

The query is trimmed and must contain non-whitespace text. `--limit` caps the
final merged list, never an individual engine's normal first-page results.
Invalid limits, queries, or engine selections (including duplicate ids) make
the command exit non-zero before any engine is called. Text output includes a
result ref and engine attribution; `--json` returns the same merged response.

Rate limiting is in-memory, so it does **not** survive across invocations: a
shell loop calling the CLI repeatedly gets no spacing between searches.

### `engines`

Lists the engines currently registered, with `--json` for machine-readable output.

## Scripts

```bash
npm run build -w @searchicus/cli
npm run test -w @searchicus/cli
npm run typecheck -w @searchicus/cli
```

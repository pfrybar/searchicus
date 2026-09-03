# @searchicus/cli

The `searchicus` command-line interface — a thin adapter over the `core`
package's `SearchEngineRegistry`. Only the mock engine ships registered;
see the repo root `README.md` for adding a browser-backed one.

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
| `-l, --limit <n>`      | Max results per engine (`1`–`100`, default `10`)            |
| `--json`               | Print raw JSON instead of a formatted list                  |

The query is trimmed and must contain non-whitespace text. Invalid limits or
queries make the command exit non-zero before any engine is called.

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

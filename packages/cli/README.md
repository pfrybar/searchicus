# @searchicus/cli

The `searchicus` command-line interface. Currently searches against the
`core` package's `MockSearchEngine` — real backends aren't wired up yet
(see the repo root `README.md`/`AGENTS.md`).

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

| Option | Description |
| --- | --- |
| `-e, --engine <id...>` | Engine id(s) to search; defaults to every registered engine |
| `-l, --limit <n>` | Max results per engine (default `10`) |
| `--json` | Print raw JSON instead of a formatted list |

### `engines`

Lists the engines currently registered, with `--json` for machine-readable output.

## Scripts

```bash
npm run build -w @searchicus/cli
npm run test -w @searchicus/cli
npm run typecheck -w @searchicus/cli
```

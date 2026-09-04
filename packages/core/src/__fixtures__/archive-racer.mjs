// One archive write, as its own process. Used by storage.test.ts to reproduce
// several processes reaching a brand-new database together — the API and CLI
// share one archive file, so that is an ordinary first start on a shared
// volume. It cannot be done in-process: node:sqlite is synchronous, so the
// event loop serializes two archives in one process however they interleave.
//
// Imports the built output because Node cannot load this package's TypeScript;
// `npm test` in core builds first for exactly this reason.
import { SqliteSearchArchive } from "../../dist/storage.js";

const [, , filePath, searchId] = process.argv;
const query = { query: "cats" };
const store = new SqliteSearchArchive(filePath);

try {
  await store.archive({
    searchId,
    startedAt: new Date().toISOString(),
    query,
    engineIds: ["bing"],
    outcomes: [{ engineId: "bing", ok: true, tookMs: 5, response: { query, engine: "bing", tookMs: 5, results: [] } }],
    response: { searchId, query, results: [], tookMs: 5, degraded: false },
    tookMs: 5,
  });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}

await store.close();

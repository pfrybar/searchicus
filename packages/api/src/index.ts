import { existsSync } from "node:fs";
import path from "node:path";
import { createDefaultSearchArchive } from "@searchicus/core";
import { createBrowserExtraction, createBrowserRegistry } from "@searchicus/core/browser";
import { createApp, defaultUiDir } from "./app.js";
import { shutdownOn } from "./shutdown.js";

const port = Number(process.env.PORT ?? 3000);

/** Treats the usual falsy spellings as "off"; anything else (or unset) is on. */
function enabled(value: string | undefined): boolean {
  return !["false", "0", "no"].includes((value ?? "").toLowerCase());
}

// MCP is served from this process by default. Disabling it leaves the
// search API untouched; see CreateAppOptions for why they share a process.
const mcp = enabled(process.env.MCP_ENABLED);

// The UI is served only when a build is actually present, so running the API
// from a fresh checkout doesn't 404 confusingly at /. In development the Vite
// dev server on :5173 serves the UI instead and proxies /api here.
const uiDir = process.env.UI_DIST_DIR ?? defaultUiDir();
const ui = enabled(process.env.SERVE_UI) && existsSync(path.join(uiDir, "index.html"));

// One archive, shared: search and extraction write to the same file, and one
// connection in one process beats two. They deliberately do not share a
// browser -- see createBrowserExtraction.
const archive = createDefaultSearchArchive();
const registry = createBrowserRegistry("api", { archive });
const extraction = createBrowserExtraction({ archive });
const server = createApp(registry, { mcp, ui: ui && uiDir, extraction, insights: archive }).listen(port, () => {
  console.log(`searchicus API listening on http://localhost:${port}`);
  console.log(`  search API at /api (also at the root, for compatibility)`);
  console.log(mcp ? `  MCP (Streamable HTTP) at /mcp` : "  MCP endpoint disabled");
  console.log(
    extraction.enabled ? "  extraction enabled at /api/extract" : "  extraction disabled (SEARCHICUS_EXTRACT_ENABLED)",
  );
  console.log(
    archive ? "  dashboard data at /api/metrics/engines and /api/searches" : "  archive disabled: no dashboard data",
  );
  console.log(ui ? `  UI served from ${uiDir}` : "  UI not served (no build found)");
});

shutdownOn(server, {
  // Extraction closes first: that stops new renders starting, and the
  // registry owns the archive both of them write to.
  close: async () => {
    await extraction.close();
    await registry.close();
  },
});

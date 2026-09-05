import { existsSync } from "node:fs";
import path from "node:path";
import { createDefaultSearchArchive, defaultDataDir, envOptOut } from "@searchicus/core";
import { createBrowserExtraction, createBrowserRegistry } from "@searchicus/core/browser";
import { createApp, defaultUiDir } from "./app.js";
import { shutdownOn } from "./shutdown.js";

const port = Number(process.env.PORT ?? 3000);

/**
 * Loopback unless told otherwise.
 *
 * This server has no authentication and its dashboard endpoints serve every
 * query ever made through it, so the default binds where only this machine
 * can reach it. Deployments that need more say so: the image sets
 * HOST=0.0.0.0, because a container that listens only on its own loopback
 * cannot be reached at all.
 */
const host = process.env.HOST ?? "127.0.0.1";

// MCP is served from this process by default. Disabling it leaves the
// search API untouched; see CreateAppOptions for why they share a process.
const mcp = envOptOut(process.env.MCP_ENABLED);

// The UI is served only when a build is actually present, so running the API
// from a fresh checkout doesn't 404 confusingly at /. In development the Vite
// dev server on :5173 serves the UI instead and proxies /api here.
const uiDir = process.env.UI_DIST_DIR ?? defaultUiDir();
const ui = envOptOut(process.env.SERVE_UI) && existsSync(path.join(uiDir, "index.html"));

// One archive, shared: search and extraction write to the same file, and one
// connection in one process beats two. They deliberately do not share a
// browser -- see createBrowserExtraction.
const archive = createDefaultSearchArchive();
const registry = createBrowserRegistry("api", { archive });
const extraction = createBrowserExtraction({ archive });
const server = createApp(registry, { mcp, ui: ui && uiDir, extraction, insights: archive }).listen(port, host, () => {
  console.log(`searchicus API listening on http://${host}:${port}`);
  console.log(`  search API at /api (also at the root, for compatibility)`);
  console.log(mcp ? `  MCP (Streamable HTTP) at /mcp` : "  MCP endpoint disabled");
  console.log(
    extraction.enabled ? "  extraction enabled at /api/extract" : "  extraction disabled (SEARCHICUS_EXTRACT_ENABLED)",
  );
  console.log(
    archive ? "  dashboard data at /api/metrics/engines and /api/searches" : "  archive disabled: no dashboard data",
  );
  // Printed because the failure this guards against was silent: two data
  // roots, each working perfectly, and nothing to say which one was in use.
  console.log(`  persistent state in ${defaultDataDir()}`);
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

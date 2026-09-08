import { existsSync } from "node:fs";
import path from "node:path";
import {
  ConfigError,
  createDefaultSearchArchive,
  createLogger,
  loadConfig,
  resolveDataDir,
  setLogLevel,
  type SearchicusConfig,
} from "@searchicus/core";
import { createBrowserExtraction, createBrowserRegistry } from "@searchicus/core/browser";
import { createApp, defaultUiDir } from "./app.js";
import { shutdownOn } from "./shutdown.js";

const log = createLogger("api");

/**
 * Everything this process is configured with, read once.
 *
 * An invalid value throws here, before a port is bound or a browser profile
 * is touched, and the error names both the setting and where it came from.
 * Nothing below this line reads the environment for itself.
 */
const config = configure();
setLogLevel(config.log.level);

/**
 * Reads the configuration, or says exactly what is wrong with it and stops.
 *
 * One line per problem rather than the joined message, so a misconfiguration
 * reads like every other thing this process reports instead of a paragraph
 * pushed through a one-line-per-entry format.
 */
function configure(): SearchicusConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const problem of err.problems) log.error("invalid configuration", { problem });
    process.exit(1);
  }
}

// The UI is served only when a build is actually present, so running the API
// from a fresh checkout doesn't 404 confusingly at /. In development the Vite
// dev server on :5173 serves the UI instead and proxies /api here.
const uiDir = config.server.uiDir ?? defaultUiDir();
const ui = config.server.ui && existsSync(path.join(uiDir, "index.html"));

// One archive, shared: search and extraction write to the same file, and one
// connection in one process beats two. They deliberately do not share a
// browser -- see createBrowserExtraction.
const archive = createDefaultSearchArchive(config);
const registry = createBrowserRegistry("api", config, { archive });
const extraction = createBrowserExtraction(config, { archive });
const server = createApp(registry, {
  mcp: config.server.mcp,
  ui: ui && uiDir,
  extraction,
  insights: archive,
  jsonBodyLimit: config.server.jsonBodyLimit,
  runtime: () => ({ search: registry.overload, extract: extraction.overload }),
}).listen(config.server.port, config.server.host, () => {
  // Through the logger, not console: the banner is diagnostics, so it
  // belongs on the same stream and behind the same switch as everything
  // else this process reports. `log.level` controls the lot.
  log.info("listening", { url: `http://${config.server.host}:${config.server.port}`, level: config.log.level });
  log.info("routes", {
    search: "/api and /",
    mcp: config.server.mcp ? "/mcp" : "disabled",
    ui: ui ? uiDir : "not served",
  });
  log.info("features", {
    extract: extraction.enabled ? "enabled" : "disabled (extract.enabled)",
    dashboard: archive ? "enabled" : "disabled (no archive)",
  });
  // Reported because the failure this guards against was silent: two data
  // roots, each working perfectly, and nothing to say which was in use.
  log.info("persistent state", { dataDir: resolveDataDir(config.paths) });
});

shutdownOn(server, {
  // Extraction closes first: that stops new renders starting, and the
  // registry owns the archive both of them write to.
  close: async () => {
    await extraction.close();
    await registry.close();
  },
});

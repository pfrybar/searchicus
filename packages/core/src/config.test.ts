import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE } from "./browser/stealth.js";
import { DEFAULT_EXTRACT_CONFIG } from "./extract/config.js";
import { DEFAULT_METRICS_WINDOW, DEFAULT_SEARCH_PAGE_SIZE, MAX_INSIGHTS_LIMIT } from "./insights.js";
import { DEFAULT_RESULTS_TIMEOUT_MS, DEFAULT_SEARCH_RESERVE_MS, DEFAULT_SESSION_TIMEOUT_MS } from "./registry.js";
import { ARCHIVE_BUSY_TIMEOUT_MS } from "./storage.js";
import { DEFAULT_JITTER, DEFAULT_MAX_QUEUED, DEFAULT_MIN_INTERVAL_MS } from "./throttle.js";
import {
  CONFIG_PATH_ENV,
  ConfigError,
  configLeafPaths,
  DEFAULT_CONFIG_INPUT,
  envNameForPath,
  loadConfig,
} from "./config.js";

const directories: string[] = [];

/** Writes a config file and returns its path. */
function configFile(contents: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "searchicus-config-"));
  directories.push(directory);
  const file = path.join(directory, "config.yaml");
  writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns the documented defaults with no file and no environment", () => {
    const config = loadConfig({ env: {}, file: null });

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(3000);
    expect(config.log.level).toBe("info");
    expect(config.archive.enabled).toBe(true);
    expect(config.search.throttle.minIntervalMs).toBe(5_000);
    expect(config.extract.enabled).toBe(false);
    expect(config.dashboard.metricsWindow).toBe(500);
  });

  it("keeps the extraction slice in the shape the extraction stack expects", () => {
    const config = loadConfig({ env: {}, file: null });

    expect(config.extract.allowedPorts).toBeInstanceOf(Set);
    expect([...config.extract.allowedPorts]).toEqual([80, 443]);
  });

  it("takes values from a file, leaving the rest at their defaults", () => {
    const file = configFile("server:\n  port: 8080\nextract:\n  enabled: true\n");
    const config = loadConfig({ env: {}, file });

    expect(config.server.port).toBe(8080);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.extract.enabled).toBe(true);
    expect(config.extract.maxConcurrent).toBe(2);
  });

  it("lets the environment override the file", () => {
    const file = configFile("server:\n  port: 8080\n  host: 0.0.0.0\n");
    const config = loadConfig({ env: { SEARCHICUS_SERVER_PORT: "9999" }, file });

    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe("0.0.0.0");
  });

  it("reads an empty file as defaults", () => {
    expect(loadConfig({ env: {}, file: configFile("\n# nothing yet\n") }).server.port).toBe(3000);
  });

  it("accepts the shared boolean vocabulary from either source", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      expect(loadConfig({ env: { SEARCHICUS_EXTRACT_ENABLED: value }, file: null }).extract.enabled, value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(loadConfig({ env: { SEARCHICUS_ARCHIVE_ENABLED: value }, file: null }).archive.enabled, value).toBe(false);
    }
    expect(loadConfig({ env: {}, file: configFile("extract:\n  enabled: true\n") }).extract.enabled).toBe(true);
  });

  it("reads a port list as a YAML sequence or a comma-separated string", () => {
    const fromFile = loadConfig({ env: {}, file: configFile("extract:\n  allowedPorts: [80, 8443]\n") });
    const fromEnv = loadConfig({ env: { SEARCHICUS_EXTRACT_ALLOWED_PORTS: "80, 8443" }, file: null });

    expect([...fromFile.extract.allowedPorts]).toEqual([80, 8443]);
    expect([...fromEnv.extract.allowedPorts]).toEqual([80, 8443]);
  });

  it("clears an optional path with an empty environment value", () => {
    const file = configFile("paths:\n  storePath: /tmp/somewhere.sqlite\n");

    expect(loadConfig({ env: {}, file }).paths.storePath).toBe("/tmp/somewhere.sqlite");
    expect(loadConfig({ env: { SEARCHICUS_PATHS_STORE_PATH: "" }, file }).paths.storePath).toBeNull();
  });

  it("holds the document cap at or below the transfer budget", () => {
    const config = loadConfig({
      env: { SEARCHICUS_EXTRACT_MAX_BYTES: "1000000", SEARCHICUS_EXTRACT_MAX_DOCUMENT_BYTES: "4000000" },
      file: null,
    });

    expect(config.extract.maxDocumentBytes).toBe(1_000_000);
  });

  it("leaves a document cap below the transfer budget alone", () => {
    const config = loadConfig({
      env: { SEARCHICUS_EXTRACT_MAX_BYTES: "4000000", SEARCHICUS_EXTRACT_MAX_DOCUMENT_BYTES: "1000000" },
      file: null,
    });

    expect(config.extract.maxDocumentBytes).toBe(1_000_000);
  });
});

describe("loadConfig failures", () => {
  it("names the environment variable that carried a bad value", () => {
    expect(() => loadConfig({ env: { SEARCHICUS_SERVER_PORT: "eighty" }, file: null })).toThrow(
      /server\.port \(SEARCHICUS_SERVER_PORT\)/,
    );
  });

  it("names the file that carried a bad value", () => {
    const file = configFile("search:\n  throttle:\n    jitter: 4\n");

    expect(() => loadConfig({ env: {}, file })).toThrow(new RegExp(`search\\.throttle\\.jitter \\(${file}\\)`));
  });

  it("rejects a value outside the boolean vocabulary rather than guessing", () => {
    expect(() => loadConfig({ env: { SEARCHICUS_EXTRACT_DWELL: "maybe" }, file: null })).toThrow(
      /extract\.dwell .*expected one of true, 1, yes, on, false, 0, no, off/s,
    );
  });

  it("rejects an unrecognized key, naming it in full", () => {
    const file = configFile("extract:\n  maxByte: 1000\n");

    expect(() => loadConfig({ env: {}, file })).toThrow(/extract\.maxByte/);
  });

  it("reports every problem at once", () => {
    const error = (() => {
      try {
        loadConfig({ env: { SEARCHICUS_SERVER_PORT: "eighty", SEARCHICUS_BROWSER_MAX_PAGES: "-4" }, file: null });
        return null;
      } catch (thrown) {
        return thrown as ConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).toMatch(/SEARCHICUS_SERVER_PORT/);
    expect(error?.message).toMatch(/SEARCHICUS_BROWSER_MAX_PAGES/);
  });

  it("refuses a file that is not a mapping", () => {
    expect(() => loadConfig({ env: {}, file: configFile("- one\n- two\n") })).toThrow(/must contain a mapping/);
  });

  it("refuses a file that is not valid YAML", () => {
    expect(() => loadConfig({ env: {}, file: configFile("server: {port: 3000\n") })).toThrow(/not valid YAML/);
  });

  it("refuses a named config file that does not exist", () => {
    expect(() => loadConfig({ env: { [CONFIG_PATH_ENV]: "/nowhere/searchicus.yaml" } })).toThrow(
      new RegExp(`${CONFIG_PATH_ENV} names .*searchicus\\.yaml, which does not exist`),
    );
  });

  it("reads the file named by the environment", () => {
    const file = configFile("log:\n  level: debug\n");

    expect(loadConfig({ env: { [CONFIG_PATH_ENV]: file } }).log.level).toBe("debug");
  });
});

describe("environment names", () => {
  it("derives one name per configurable leaf", () => {
    const leaves = configLeafPaths();
    const names = new Set(leaves.map(envNameForPath));

    expect(leaves.length).toBeGreaterThan(0);
    expect(names.size).toBe(leaves.length);
  });

  it("splits camelCase segments and prefixes every name", () => {
    expect(envNameForPath(["extract", "cache", "ttlMs"])).toBe("SEARCHICUS_EXTRACT_CACHE_TTL_MS");
    expect(envNameForPath(["extract", "maxDocumentBytes"])).toBe("SEARCHICUS_EXTRACT_MAX_DOCUMENT_BYTES");
    expect(envNameForPath(["server", "uiDir"])).toBe("SEARCHICUS_SERVER_UI_DIR");
  });

  it("never collides with the variable that names the config file itself", () => {
    expect(configLeafPaths().map(envNameForPath)).not.toContain(CONFIG_PATH_ENV);
  });

  it("treats a list and an unset optional as leaves, not branches", () => {
    const dotted = configLeafPaths().map((segments) => segments.join("."));

    expect(dotted).toContain("extract.allowedPorts");
    expect(dotted).toContain("paths.profileDir");
    expect(DEFAULT_CONFIG_INPUT.paths.profileDir).toBeNull();
  });
});

describe("config.example.yaml", () => {
  const example = readFileSync(fileURLToPath(new URL("../../../config.example.yaml", import.meta.url)), "utf8");

  it("documents every section of the tree", () => {
    for (const section of Object.keys(DEFAULT_CONFIG_INPUT)) {
      expect(example, section).toContain(`# ${section}:`);
    }
  });

  it("documents every setting an operator can change", () => {
    // The example is the only place the whole tree is written out for a
    // person, so a setting missing from it is a setting nobody finds.
    //
    // Counted rather than merely matched: `enabled` is a leaf of three
    // different sections and `maxQueued` of two, so a present-somewhere check
    // would pass while the example was missing two of each.
    const wanted = new Map<string, number>();
    for (const segments of configLeafPaths()) {
      const key = segments[segments.length - 1] as string;
      wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }

    for (const [key, count] of wanted) {
      const documented = example.match(new RegExp(`^#\\s+${key}:`, "gm"))?.length ?? 0;
      expect(documented, key).toBe(count);
    }
  });
});

describe("configured defaults", () => {
  // The tree is written out as plain data so a person can read it, which
  // means every value in it also exists as the constant its own module falls
  // back to when nobody configures anything. They are only equal because
  // nothing has changed one of them alone — a library caller constructing a
  // Throttle or an archive directly gets the constant, not the tree.
  it("matches the fallback each module uses when it is given no configuration", () => {
    expect(DEFAULT_CONFIG_INPUT.search).toMatchObject({
      resultsTimeoutMs: DEFAULT_RESULTS_TIMEOUT_MS,
      sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
      reserveMs: DEFAULT_SEARCH_RESERVE_MS,
      throttle: {
        minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
        jitter: DEFAULT_JITTER,
        maxQueued: DEFAULT_MAX_QUEUED,
      },
    });
    expect(DEFAULT_CONFIG_INPUT.archive.busyTimeoutMs).toBe(ARCHIVE_BUSY_TIMEOUT_MS);
    expect(DEFAULT_CONFIG_INPUT.dashboard).toEqual({
      metricsWindow: DEFAULT_METRICS_WINDOW,
      searchPageSize: DEFAULT_SEARCH_PAGE_SIZE,
      maxLimit: MAX_INSIGHTS_LIMIT,
    });
  });

  it("matches DEFAULT_EXTRACT_CONFIG field for field", () => {
    expect({
      ...DEFAULT_CONFIG_INPUT.extract,
      allowedPorts: new Set(DEFAULT_CONFIG_INPUT.extract.allowedPorts),
    }).toEqual(DEFAULT_EXTRACT_CONFIG);
  });

  it("uses the browser identity the stealth layer falls back to", () => {
    expect(DEFAULT_CONFIG_INPUT.browser).toMatchObject({ locale: DEFAULT_LOCALE, timezone: DEFAULT_TIMEZONE });
  });
});

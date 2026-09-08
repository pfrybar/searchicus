import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchArchiveRecord } from "./archive.js";
import { DEFAULT_CONFIG_INPUT } from "./config.js";
import { DEFAULT_DASHBOARD_CONFIG } from "./insights.js";
import { resolveDataDir, resolveProfileDir, resolveStorePath, type PathsConfig } from "./paths.js";
import { ARCHIVE_SCHEMA_VERSION, createDefaultSearchArchive, SqliteSearchArchive } from "./storage.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "searchicus-archive-"));
  directories.push(directory);
  return path.join(directory, "searchicus.sqlite");
}

function record(overrides: Partial<SearchArchiveRecord> = {}): SearchArchiveRecord {
  const query = { query: "cats" };
  const response = {
    searchId: "search-123",
    query,
    results: [
      {
        ref: "search-123-1",
        title: "Cats",
        url: "https://example.test/cats",
        snippet: "Everything about cats",
        score: 0.016,
        bestSource: "bing",
        found: [{ engineId: "bing", rank: 1 }],
        families: ["bing"],
      },
    ],
    tookMs: 31,
    degraded: true,
  };

  return {
    searchId: "search-123",
    startedAt: "2026-09-04T16:00:00.000Z",
    query,
    engineIds: ["bing", "broken"],
    outcomes: [
      {
        engineId: "bing",
        ok: true,
        tookMs: 21,
        response: {
          query,
          engine: "bing",
          tookMs: 20,
          results: [
            {
              title: "Cats",
              url: "https://example.test/cats",
              snippet: "Everything about cats",
              source: "bing",
            },
          ],
        },
      },
      { engineId: "broken", ok: false, tookMs: 30, errorKind: "timeout", error: "Engine timed out" },
    ],
    response,
    tookMs: 31,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A paths slice with the defaults for anything the caller does not set. */
function paths(overrides: Partial<PathsConfig> = {}): PathsConfig {
  return { ...DEFAULT_CONFIG_INPUT.paths, ...overrides };
}

describe("persistent data paths", () => {
  it("keeps the archive beside, rather than inside, surface profiles", () => {
    const configured = paths({ dataDir: "/var/lib/searchicus" });

    expect(resolveDataDir(configured)).toBe("/var/lib/searchicus");
    expect(resolveProfileDir(configured, "api")).toBe("/var/lib/searchicus/profile/api");
    expect(resolveStorePath(configured)).toBe("/var/lib/searchicus/searchicus.sqlite");
  });

  it("resolves the same state root however the process was started", async () => {
    // The regression: the data root came from process.cwd(), and `npm run -w
    // <package>` sets that to the package directory. The API resolved
    // packages/api/.searchicus while the CLI resolved the repository root, so
    // the archive they are designed to share was silently two databases — and
    // nothing complained, because each one worked perfectly on its own.
    //
    // This has to be a real process per working directory: the resolution is
    // a property of where the process started, which one test run cannot
    // observe from inside itself.
    const printer = fileURLToPath(new URL("./__fixtures__/print-paths.mjs", import.meta.url));
    const root = fileURLToPath(new URL("../../..", import.meta.url));

    const resolve = async (cwd: string): Promise<{ cwd: string; dataDir: string; store: string }> => {
      const { stdout } = await execFileAsync(process.execPath, ["--no-warnings=ExperimentalWarning", printer], { cwd });
      return JSON.parse(stdout) as { cwd: string; dataDir: string; store: string };
    };

    const [fromRoot, fromPackage, fromElsewhere] = await Promise.all([
      resolve(root),
      resolve(path.join(root, "packages", "api")),
      resolve(tmpdir()),
    ]);

    // Different working directories, deliberately.
    expect(new Set([fromRoot.cwd, fromPackage.cwd, fromElsewhere.cwd]).size).toBe(3);
    // One archive.
    expect(fromPackage.store).toBe(fromRoot.store);
    expect(fromElsewhere.store).toBe(fromRoot.store);
    expect(fromRoot.dataDir).toBe(path.join(root, ".searchicus"));
  });

  it("takes a component-specific override over the derived path", () => {
    const configured = paths({
      dataDir: "/data",
      profileDir: "/browser/api",
      storePath: "/archive/searchicus.sqlite",
    });

    expect(resolveProfileDir(configured, "api")).toBe("/browser/api");
    expect(resolveStorePath(configured)).toBe("/archive/searchicus.sqlite");
    // The root still moves everything that was not overridden.
    expect(resolveDataDir(configured)).toBe("/data");
  });

  it("builds no archive at all when archiving is switched off", () => {
    const configured = paths({ storePath: "/archive/searchicus.sqlite" });

    expect(
      createDefaultSearchArchive({
        archive: { enabled: false, busyTimeoutMs: 5_000 },
        paths: configured,
        dashboard: DEFAULT_DASHBOARD_CONFIG,
      }),
    ).toBeUndefined();
    expect(
      createDefaultSearchArchive({
        archive: { enabled: true, busyTimeoutMs: 5_000 },
        paths: configured,
        dashboard: DEFAULT_DASHBOARD_CONFIG,
      }),
    ).toBeInstanceOf(SqliteSearchArchive);
  });

  it("opens the archive at the configured path", () => {
    const file = temporaryDatabase();
    const archive = createDefaultSearchArchive({
      archive: { enabled: true, busyTimeoutMs: 5_000 },
      paths: paths({ storePath: file }),
      dashboard: DEFAULT_DASHBOARD_CONFIG,
    });

    expect(archive?.filePath).toBe(file);
  });
});

describe("SqliteSearchArchive", () => {
  it("stores the client-visible merge and every raw engine outcome under one search id", async () => {
    const filePath = temporaryDatabase();
    const store = new SqliteSearchArchive(filePath);
    await store.archive(record());
    await store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    try {
      const search = db.prepare("SELECT * FROM searches WHERE search_id = ?").get("search-123") as Record<
        string,
        unknown
      >;
      expect(search).toMatchObject({
        search_id: "search-123",
        query: "cats",
        status: "completed",
        took_ms: 31,
        degraded: 1,
        schema_version: ARCHIVE_SCHEMA_VERSION,
      });
      expect(JSON.parse(String(search.selected_engine_ids_json))).toEqual(["bing", "broken"]);
      expect(JSON.parse(String(search.merged_response_json))).toMatchObject({
        searchId: "search-123",
        results: [{ ref: "search-123-1" }],
      });

      const outcomes = db
        .prepare("SELECT * FROM engine_results WHERE search_id = ? ORDER BY engine_position")
        .all("search-123") as Record<string, unknown>[];
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({
        search_id: "search-123",
        engine_id: "bing",
        succeeded: 1,
        result_count: 1,
        error_kind: null,
      });
      expect(JSON.parse(String(outcomes[0]?.raw_response_json))).toMatchObject({ engine: "bing" });
      expect(outcomes[1]).toMatchObject({
        search_id: "search-123",
        engine_id: "broken",
        succeeded: 0,
        result_count: 0,
        error_kind: "timeout",
        error_message: "Engine timed out",
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extractions'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("records total failures without pretending that a merged response existed", async () => {
    const filePath = temporaryDatabase();
    const store = new SqliteSearchArchive(filePath);
    await store.archive(
      record({
        response: undefined,
        outcomes: [{ engineId: "bing", ok: false, tookMs: 12, errorKind: "browser_unavailable", error: "no browser" }],
      }),
    );
    await store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filePath);
    try {
      expect(db.prepare("SELECT status, merged_response_json, degraded FROM searches").get()).toEqual({
        status: "failed",
        merged_response_json: null,
        degraded: null,
      });
      expect(db.prepare("SELECT error_kind FROM engine_results").get()).toEqual({ error_kind: "browser_unavailable" });
    } finally {
      db.close();
    }
  });

  it("reuses an archive that already carries the current schema", async () => {
    const filePath = temporaryDatabase();
    const first = new SqliteSearchArchive(filePath);
    await first.archive(record());
    await first.close();

    // Every other case here starts from an empty file, so nothing otherwise
    // exercises the migration's early return on an existing database.
    const second = new SqliteSearchArchive(filePath);
    await second.archive(record({ searchId: "search-456" }));
    await second.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filePath);
    try {
      expect(db.prepare("SELECT search_id FROM searches ORDER BY search_id").all()).toEqual([
        { search_id: "search-123" },
        { search_id: "search-456" },
      ]);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: ARCHIVE_SCHEMA_VERSION });
    } finally {
      db.close();
    }
  });

  it("answers the dashboard's window query from an index rather than sorting the table", async () => {
    // The window is bounded so reading it stays cheap, which does nothing if
    // *finding* the window costs a full scan and a temporary B-tree — and it
    // did, three times per metrics request, growing with the archive.
    const filePath = temporaryDatabase();
    const archive = new SqliteSearchArchive(filePath);
    await archive.archive(record());
    await archive.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filePath);
    try {
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT search_id FROM searches ORDER BY started_at DESC, search_id DESC LIMIT 5")
        .all()
        .map((row) => String((row as { detail: string }).detail))
        .join(" ");

      expect(plan).toContain("searches_recent");
      expect(plan).not.toContain("TEMP B-TREE");
    } finally {
      db.close();
    }
  });

  it("adds the window index to an archive written before it existed", async () => {
    const filePath = temporaryDatabase();
    const { DatabaseSync } = await import("node:sqlite");

    // Schema 1 as the previous release left it: the tables, none of the
    // later indexes. An upgrade must add the index and keep the rows.
    const seed = new DatabaseSync(filePath);
    seed.exec(`
      CREATE TABLE searches (
        search_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, query TEXT NOT NULL,
        selected_engine_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        merged_response_json TEXT, took_ms INTEGER NOT NULL,
        degraded INTEGER, schema_version INTEGER NOT NULL
      );
      CREATE TABLE engine_results (
        search_id TEXT NOT NULL REFERENCES searches(search_id) ON DELETE CASCADE,
        engine_id TEXT NOT NULL, engine_position INTEGER NOT NULL, succeeded INTEGER NOT NULL,
        took_ms INTEGER NOT NULL, result_count INTEGER NOT NULL, coverage REAL, match REAL,
        raw_response_json TEXT, error_kind TEXT, error_message TEXT,
        PRIMARY KEY (search_id, engine_id)
      );
      CREATE TABLE extractions (
        extraction_id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
        search_id TEXT REFERENCES searches(search_id) ON DELETE CASCADE, result_ref TEXT,
        requested_url TEXT NOT NULL, final_url TEXT, status TEXT NOT NULL, error_kind TEXT,
        http_status INTEGER, content_type TEXT, redirects INTEGER, took_ms INTEGER NOT NULL,
        title TEXT, domain TEXT, language TEXT, author TEXT, published TEXT, chars INTEGER,
        word_count INTEGER, truncated INTEGER, markdown_sha256 TEXT
      );
      INSERT INTO searches VALUES ('older-1', '2026-01-01T00:00:00.000Z', 'q', '[]', 'completed', NULL, 1, 0, 1);
      PRAGMA user_version = 1;
    `);
    seed.close();

    const archive = new SqliteSearchArchive(filePath);
    expect(await archive.recentSearches({ limit: 5 })).toHaveLength(1);
    await archive.close();

    const db = new DatabaseSync(filePath);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: ARCHIVE_SCHEMA_VERSION });
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'searches_recent'")
        .all();
      expect(indexes).toHaveLength(1);
      // The upgrade adds an index; it must not lose what was already stored.
      expect(db.prepare("SELECT count(*) AS total FROM searches").get()).toEqual({ total: 1 });
    } finally {
      db.close();
    }
  });

  it("refuses reads after close instead of quietly opening a second connection", async () => {
    // Writes always refused; reads called #open() again and carried on
    // working, so "closed" meant two different things depending on which
    // method you called — and a drained shutdown could leave a live handle.
    const filePath = temporaryDatabase();
    const archive = new SqliteSearchArchive(filePath);
    await archive.archive(record());
    expect(await archive.recentSearches()).toHaveLength(1);
    await archive.close();

    await expect(archive.recentSearches()).rejects.toThrow(/closed/);
    await expect(archive.engineMetrics()).rejects.toThrow(/closed/);
    await expect(archive.searchDetail("search-123")).rejects.toThrow(/closed/);
    await expect(archive.archive(record({ searchId: "later" }))).rejects.toThrow(/closed/);
  });

  it("adds the cached column to an archive written before it, keeping the rows", async () => {
    const filePath = temporaryDatabase();
    const archive = new SqliteSearchArchive(filePath);
    await archive.archive(record());
    await archive.recordExtraction({
      startedAt: "2026-09-04T16:00:30.000Z",
      requestedUrl: "https://example.test/a",
      status: "completed",
      tookMs: 5000,
      domain: "example.test",
    });
    await archive.close();

    const { DatabaseSync } = await import("node:sqlite");
    const rolled = new DatabaseSync(filePath);
    // Wind the file back to schema 2 with the column dropped, which is what
    // an archive written by the previous release looks like.
    rolled.exec("ALTER TABLE extractions DROP COLUMN cached");
    rolled.exec("PRAGMA user_version = 2");
    rolled.close();

    const upgraded = new SqliteSearchArchive(filePath);
    const report = await upgraded.engineMetrics();
    await upgraded.close();

    // The row survives, and a read recorded before the column existed counts
    // as a render rather than vanishing from the median.
    expect(report.extractions.attempted).toBe(1);
    expect(report.extractions.cached).toBe(0);
    expect(report.extractions.medianTookMs).toBe(5000);

    const db = new DatabaseSync(filePath);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: ARCHIVE_SCHEMA_VERSION });
      const columns = db.prepare("PRAGMA table_info(extractions)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("cached");
    } finally {
      db.close();
    }
  });

  it("adds the degraded_by column to an archive written before it, keeping the rows", async () => {
    const filePath = temporaryDatabase();
    const archive = new SqliteSearchArchive(filePath);
    await archive.recordExtraction({
      startedAt: "2026-09-07T16:00:30.000Z",
      requestedUrl: "https://example.test/heavy",
      status: "completed",
      tookMs: 5000,
      domain: "example.test",
      degradedBy: "bytes",
    });
    await archive.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filePath);
    try {
      expect(db.prepare("SELECT degraded_by FROM extractions").get()).toEqual({ degraded_by: "bytes" });
    } finally {
      db.close();
    }

    // Wind the file back to schema 4, which is what an archive written by the
    // previous release looks like.
    const rolled = new DatabaseSync(filePath);
    rolled.exec("ALTER TABLE extractions DROP COLUMN degraded_by");
    rolled.exec("PRAGMA user_version = 4");
    rolled.close();

    const upgraded = new SqliteSearchArchive(filePath);
    // A row written before the column existed stays NULL rather than being
    // guessed at: renders from that release could not be degraded, because
    // one that hit either bound failed outright instead.
    await upgraded.recordExtraction({
      startedAt: "2026-09-07T16:00:40.000Z",
      requestedUrl: "https://example.test/clean",
      status: "completed",
      tookMs: 100,
      domain: "example.test",
    });
    await upgraded.close();

    const reopened = new DatabaseSync(filePath);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: ARCHIVE_SCHEMA_VERSION });
      const rows = reopened.prepare("SELECT requested_url, degraded_by FROM extractions ORDER BY created_at").all();
      expect(rows).toEqual([
        { requested_url: "https://example.test/heavy", degraded_by: null },
        { requested_url: "https://example.test/clean", degraded_by: null },
      ]);
    } finally {
      reopened.close();
    }
  });

  it("migrates schema 5 rows before recording unusable outcomes", async () => {
    const filePath = temporaryDatabase();
    const archive = new SqliteSearchArchive(filePath);
    await archive.archive(record());
    await archive.close();

    const { DatabaseSync } = await import("node:sqlite");
    const rolled = new DatabaseSync(filePath);
    rolled.exec(`
      DROP TABLE extractions;
      CREATE TABLE extractions (
        extraction_id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        requested_url TEXT NOT NULL,
        final_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        error_kind TEXT,
        http_status INTEGER,
        content_type TEXT,
        redirects INTEGER,
        took_ms INTEGER NOT NULL CHECK (took_ms >= 0),
        title TEXT,
        domain TEXT,
        language TEXT,
        author TEXT,
        published TEXT,
        chars INTEGER,
        word_count INTEGER,
        truncated INTEGER CHECK (truncated IN (0, 1)),
        markdown_sha256 TEXT,
        cached INTEGER CHECK (cached IN (0, 1)),
        degraded_by TEXT CHECK (degraded_by IN ('bytes', 'requests')),
        CHECK (
          (status = 'completed' AND error_kind IS NULL) OR
          (status = 'failed' AND error_kind IS NOT NULL)
        )
      );
      CREATE INDEX extractions_by_domain ON extractions (domain, created_at);
      CREATE INDEX extractions_recent ON extractions (created_at);
      INSERT INTO extractions (created_at, requested_url, status, took_ms, domain)
        VALUES ('2026-09-07T16:01:00.000Z', 'https://example.test/legacy', 'completed', 700, 'example.test');
      PRAGMA user_version = 5;
    `);
    rolled.close();

    const upgraded = new SqliteSearchArchive(filePath);
    await upgraded.recordExtraction({
      startedAt: "2026-09-07T16:02:00.000Z",
      requestedUrl: "https://example.test/denied",
      status: "unusable",
      operation: "extract",
      unusableKind: "access_denied",
      classifierVersion: "1",
      httpStatus: 403,
      tookMs: 300,
    });
    await upgraded.close();

    const reopened = new DatabaseSync(filePath);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: ARCHIVE_SCHEMA_VERSION });
      expect(
        reopened.prepare("SELECT requested_url, status, unusable_kind FROM extractions ORDER BY extraction_id").all(),
      ).toEqual([
        { requested_url: "https://example.test/legacy", status: "completed", unusable_kind: null },
        { requested_url: "https://example.test/denied", status: "unusable", unusable_kind: "access_denied" },
      ]);
    } finally {
      reopened.close();
    }
  });

  it("rebuilds an archive that still records where a caller said they came from", async () => {
    const filePath = temporaryDatabase();
    const archive = new SqliteSearchArchive(filePath);
    await archive.archive(record());
    await archive.close();

    const { DatabaseSync } = await import("node:sqlite");
    const rolled = new DatabaseSync(filePath);
    // Rebuild the schema-3 extractions table, complete with the CHECK that
    // makes SQLite refuse a plain DROP COLUMN, and put a correlated row in it.
    rolled.exec(`
      DROP TABLE extractions;
      CREATE TABLE extractions (
        extraction_id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        search_id TEXT REFERENCES searches(search_id) ON DELETE CASCADE,
        result_ref TEXT,
        requested_url TEXT NOT NULL,
        final_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        error_kind TEXT,
        http_status INTEGER,
        content_type TEXT,
        redirects INTEGER,
        took_ms INTEGER NOT NULL CHECK (took_ms >= 0),
        title TEXT,
        domain TEXT,
        language TEXT,
        author TEXT,
        published TEXT,
        chars INTEGER,
        word_count INTEGER,
        truncated INTEGER CHECK (truncated IN (0, 1)),
        markdown_sha256 TEXT,
        cached INTEGER CHECK (cached IN (0, 1)),
        CHECK ((search_id IS NULL) = (result_ref IS NULL)),
        CHECK (
          (status = 'completed' AND error_kind IS NULL) OR
          (status = 'failed' AND error_kind IS NOT NULL)
        )
      );
      CREATE INDEX extractions_by_result ON extractions (search_id, result_ref);
      CREATE INDEX extractions_by_domain ON extractions (domain, created_at);
      INSERT INTO extractions (created_at, search_id, result_ref, requested_url, status, took_ms, domain)
        VALUES ('2026-09-04T16:01:00.000Z', 'search-123', 'search-123-1',
                'https://example.test/cats', 'completed', 700, 'example.test');
      PRAGMA user_version = 3;
    `);
    rolled.close();

    const upgraded = new SqliteSearchArchive(filePath);
    // The read survives the rebuild and is still credited — now by its URL,
    // which is what the old columns were a caller-supplied proxy for.
    expect((await upgraded.searchDetail("search-123"))?.extractions).toBe(1);
    await upgraded.close();

    const db = new DatabaseSync(filePath);
    try {
      const columns = (db.prepare("PRAGMA table_info(extractions)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).not.toContain("search_id");
      expect(columns).not.toContain("result_ref");
      expect(columns).toContain("cached");
      expect(db.prepare("SELECT count(*) AS count FROM extractions").get()).toEqual({ count: 1 });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: ARCHIVE_SCHEMA_VERSION });
      // The surrogate key keeps counting from where it was, so ids stay
      // unique across the rebuild rather than being handed out twice.
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'extractions'").get()).toEqual({ seq: 1 });
    } finally {
      db.close();
    }
  });

  it("refuses an archive written by a newer schema rather than corrupting it", async () => {
    const filePath = temporaryDatabase();
    const { DatabaseSync } = await import("node:sqlite");
    const seed = new DatabaseSync(filePath);
    seed.exec(`PRAGMA user_version = ${ARCHIVE_SCHEMA_VERSION + 1}`);
    seed.close();

    const store = new SqliteSearchArchive(filePath);
    await expect(store.archive(record())).rejects.toThrow(/newer than supported version/);
    await store.close();
  });

  describe("extractions", () => {
    it("records what it read and nothing about where the caller got it", async () => {
      const filePath = temporaryDatabase();
      const store = new SqliteSearchArchive(filePath);
      await store.archive(record());
      await store.recordExtraction({
        startedAt: "2026-09-04T16:01:00.000Z",
        requestedUrl: "https://example.test/cats",
        finalUrl: "https://www.example.test/cats",
        status: "completed",
        httpStatus: 200,
        contentType: "text/html",
        redirects: 1,
        tookMs: 812,
        title: "Cats",
        domain: "www.example.test",
        chars: 1200,
        wordCount: 210,
        truncated: false,
        markdownSha256: "a".repeat(64),
      });
      await store.recordExtraction({
        startedAt: "2026-09-04T16:02:00.000Z",
        requestedUrl: "https://elsewhere.test/dogs",
        status: "failed",
        errorKind: "timeout",
        tookMs: 15_000,
        domain: "elsewhere.test",
      });
      await store.close();

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
      try {
        const rows = db.prepare("SELECT * FROM extractions ORDER BY extraction_id").all() as Record<string, unknown>[];
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
          requested_url: "https://example.test/cats",
          status: "completed",
          error_kind: null,
          redirects: 1,
          truncated: 0,
        });
        expect(rows[1]).toMatchObject({
          requested_url: "https://elsewhere.test/dogs",
          status: "failed",
          error_kind: "timeout",
        });
        // A read records the page, never who sent the caller to it: the
        // search that offered a URL is worked out at read time instead.
        expect(Object.keys(rows[0] ?? {})).not.toContain("search_id");
        expect(Object.keys(rows[0] ?? {})).not.toContain("result_ref");
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    });

    it("stores unusable diagnostics separately without granting successful-read credit", async () => {
      const filePath = temporaryDatabase();
      const store = new SqliteSearchArchive(filePath);
      await store.archive(record());
      await store.recordExtraction({
        startedAt: "2026-09-04T16:01:00.000Z",
        requestedUrl: "https://example.test/cats",
        finalUrl: "https://example.test/cats",
        status: "unusable",
        operation: "outline",
        unusableKind: "access_denied",
        classifierVersion: "1",
        httpStatus: 403,
        contentType: "text/html",
        documentChars: 0,
        tookMs: 300,
      });

      const report = await store.engineMetrics();
      expect(report.extractions).toMatchObject({
        attempted: 1,
        completed: 0,
        unusable: 1,
        failed: 0,
        unusableReasons: [{ kind: "access_denied", count: 1 }],
      });
      expect(report.engines.find((engine) => engine.engineId === "bing")?.extracted).toBe(0);
      const detail = await store.searchDetail("search-123");
      expect(detail?.extractions).toBe(0);
      // Unusable observations still appear to operators, but do not say the
      // offered result was successfully read.
      expect(detail?.extractionDetails[0]).toMatchObject({
        status: "unusable",
        unusableKind: "access_denied",
        httpStatus: 403,
      });
      await store.close();
    });

    it("keeps no column that could hold page content", async () => {
      const filePath = temporaryDatabase();
      const store = new SqliteSearchArchive(filePath);
      await store.archive(record());
      await store.close();

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(filePath);
      try {
        // Structural, not incidental: extraction stores metadata about pages
        // and never the pages themselves, so there must be nowhere to put it.
        const columns = (db.prepare("PRAGMA table_info(extractions)").all() as { name: string }[]).map(
          (column) => column.name,
        );
        expect(columns).not.toContain("content_text");
        expect(columns.filter((name) => /content|markdown|html|text/.test(name))).toEqual([
          "content_type",
          "markdown_sha256",
        ]);
      } finally {
        db.close();
      }
    });

    it("counts repeat extractions of one result rather than collapsing them", async () => {
      const filePath = temporaryDatabase();
      const store = new SqliteSearchArchive(filePath);
      await store.archive(record());

      // Re-reading a result is the signal, not a duplicate: a key over the
      // URL would silently discard the second and third.
      for (const startedAt of ["16:01", "16:02", "16:03"]) {
        await store.recordExtraction({
          startedAt: `2026-09-04T${startedAt}:00.000Z`,
          requestedUrl: "https://example.test/cats",
          status: "completed",
          tookMs: 700,
        });
      }
      await store.close();

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(filePath);
      try {
        expect(db.prepare("SELECT count(*) AS count FROM extractions").get()).toEqual({ count: 3 });
      } finally {
        db.close();
      }
    });
  });

  it("lets several processes race to create the same new archive", { timeout: 30_000 }, async () => {
    const filePath = temporaryDatabase();
    const racer = fileURLToPath(new URL("./__fixtures__/archive-racer.mjs", import.meta.url));

    // Two regressions live here, both of which lost records silently because
    // archive writes are best-effort:
    //
    //   1. the migration read user_version before taking the write lock, so
    //      every process but the winner re-ran the DDL and died on "table
    //      searches already exists" — every time, at four processes;
    //   2. `PRAGMA journal_mode = WAL` takes an exclusive lock SQLite refuses
    //      to wait for, answering "database is locked" immediately whatever
    //      busy_timeout says — about one open in sixteen.
    const outcomes = await Promise.allSettled(
      ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((searchId) =>
        // --no-warnings keeps a failing racer's own message readable instead
        // of buried in Node's experimental-SQLite notice.
        execFileAsync(process.execPath, ["--no-warnings=ExperimentalWarning", racer, filePath, searchId]),
      ),
    );

    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected"
        ? [String((outcome.reason as { stderr?: string }).stderr ?? outcome.reason).trim()]
        : [],
    );
    expect(failures).toEqual([]);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filePath);
    try {
      expect(db.prepare("SELECT count(*) AS count FROM searches").get()).toEqual({ count: 8 });
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

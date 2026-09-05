import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchArchiveRecord } from "./archive.js";
import { defaultDataDir, defaultProfileDir, defaultStorePath, searchArchiveEnabled } from "./paths.js";
import { ARCHIVE_SCHEMA_VERSION, createDefaultSearchArchive, SqliteSearchArchive } from "./storage.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "searchicus-archive-"));
  directories.push(directory);
  return path.join(directory, "searches.sqlite");
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

describe("persistent data paths", () => {
  it("keeps the archive beside, rather than inside, surface profiles", () => {
    vi.stubEnv("SEARCHICUS_DATA_DIR", "/var/lib/searchicus");

    expect(defaultDataDir()).toBe("/var/lib/searchicus");
    expect(defaultProfileDir("api")).toBe("/var/lib/searchicus/profile/api");
    expect(defaultStorePath()).toBe("/var/lib/searchicus/searches.sqlite");
  });

  it("resolves the same state root however the process was started", async () => {
    // The regression: defaultDataDir() used process.cwd(), and `npm run -w
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
      const { stdout } = await execFileAsync(process.execPath, ["--no-warnings=ExperimentalWarning", printer], {
        cwd,
        // The ambient value would mask exactly what this is testing.
        env: { ...process.env, SEARCHICUS_DATA_DIR: undefined, SEARCHICUS_STORE_PATH: undefined },
      });
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

  it("allows a component-specific path override and disables storage on any explicit no", () => {
    vi.stubEnv("SEARCHICUS_DATA_DIR", "/data");
    vi.stubEnv("SEARCHICUS_PROFILE_DIR", "/browser/api");
    vi.stubEnv("SEARCHICUS_STORE_PATH", "/archive/searches.sqlite");
    vi.stubEnv("SEARCHICUS_STORE", "false");

    expect(defaultProfileDir("api")).toBe("/browser/api");
    expect(defaultStorePath()).toBe("/archive/searches.sqlite");
    expect(searchArchiveEnabled()).toBe(false);
    expect(createDefaultSearchArchive()).toBeUndefined();

    // "0" used to leave archiving on, because this switch understood only the
    // literal string "false" while MCP_ENABLED beside it read "0" as off.
    // One vocabulary now, so the same word means the same thing everywhere.
    for (const value of ["0", "no", "off", "FALSE"]) {
      vi.stubEnv("SEARCHICUS_STORE", value);
      expect(searchArchiveEnabled(), value).toBe(false);
    }

    // Anything that is not a no leaves archiving on, which is the default.
    vi.stubEnv("SEARCHICUS_STORE", "yes");
    expect(searchArchiveEnabled()).toBe(true);
    expect(createDefaultSearchArchive()).toBeInstanceOf(SqliteSearchArchive);
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
    it("resolves a ref back to the URL that ref actually named", async () => {
      const store = new SqliteSearchArchive(temporaryDatabase());
      await store.archive(record());

      await expect(store.findResult("search-123-1")).resolves.toEqual({
        searchId: "search-123",
        ref: "search-123-1",
        url: "https://example.test/cats",
        rank: 1,
      });
      await store.close();
    });

    it("resolves nothing for a ref that names no stored result", async () => {
      const store = new SqliteSearchArchive(temporaryDatabase());
      await store.archive(record());

      for (const ref of ["search-123-2", "search-999-1", "search-123-0", "nodash", "-1", "search-123-x"]) {
        await expect(store.findResult(ref), ref).resolves.toBeUndefined();
      }
      await store.close();
    });

    it("resolves nothing when the search failed and returned no list", async () => {
      const store = new SqliteSearchArchive(temporaryDatabase());
      await store.archive(record({ response: undefined }));

      await expect(store.findResult("search-123-1")).resolves.toBeUndefined();
      await store.close();
    });

    it("records ref-correlated and URL-only extractions side by side", async () => {
      const filePath = temporaryDatabase();
      const store = new SqliteSearchArchive(filePath);
      await store.archive(record());
      await store.recordExtraction({
        startedAt: "2026-09-04T16:01:00.000Z",
        searchId: "search-123",
        resultRef: "search-123-1",
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
          search_id: "search-123",
          result_ref: "search-123-1",
          status: "completed",
          error_kind: null,
          redirects: 1,
          truncated: 0,
        });
        // A URL the caller brought themselves has no ranking behind it, and
        // the row must not pretend otherwise.
        expect(rows[1]).toMatchObject({
          search_id: null,
          result_ref: null,
          status: "failed",
          error_kind: "timeout",
        });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
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

      // Re-reading a result is the signal, not a duplicate: a key over
      // (search_id, result_ref) would silently discard the second and third.
      for (const startedAt of ["16:01", "16:02", "16:03"]) {
        await store.recordExtraction({
          startedAt: `2026-09-04T${startedAt}:00.000Z`,
          searchId: "search-123",
          resultRef: "search-123-1",
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

    it("refuses a row claiming half a search provenance", async () => {
      const store = new SqliteSearchArchive(temporaryDatabase());
      await store.archive(record());

      await expect(
        store.recordExtraction({
          startedAt: "2026-09-04T16:01:00.000Z",
          searchId: "search-123",
          requestedUrl: "https://example.test/cats",
          status: "completed",
          tookMs: 5,
        }),
      ).rejects.toThrow(/constraint/i);
      await store.close();
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

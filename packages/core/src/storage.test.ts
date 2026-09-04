import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchArchiveRecord } from "./archive.js";
import { defaultDataDir, defaultProfileDir, defaultStorePath, searchArchiveEnabled } from "./paths.js";
import { ARCHIVE_SCHEMA_VERSION, createDefaultSearchArchive, SqliteSearchArchive } from "./storage.js";

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

  it("allows a component-specific path override and disables storage only on false", () => {
    vi.stubEnv("SEARCHICUS_DATA_DIR", "/data");
    vi.stubEnv("SEARCHICUS_PROFILE_DIR", "/browser/api");
    vi.stubEnv("SEARCHICUS_STORE_PATH", "/archive/searches.sqlite");
    vi.stubEnv("SEARCHICUS_STORE", "false");

    expect(defaultProfileDir("api")).toBe("/browser/api");
    expect(defaultStorePath()).toBe("/archive/searches.sqlite");
    expect(searchArchiveEnabled()).toBe(false);
    expect(createDefaultSearchArchive()).toBeUndefined();

    vi.stubEnv("SEARCHICUS_STORE", "0");
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
});

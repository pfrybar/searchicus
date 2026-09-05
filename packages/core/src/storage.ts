import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  boundedLimit,
  creditMergedResult,
  DEFAULT_METRICS_WINDOW,
  DEFAULT_SEARCH_PAGE_SIZE,
  percentile,
  round,
  type ArchivedEngineOutcome,
  type ArchivedExtraction,
  type ArchiveInsights,
  type EngineMetrics,
  type EngineMetricsReport,
  type SearchDetail,
  type SearchSummary,
} from "./insights.js";
import { parseResultRef } from "./ranking.js";
import { assessRelevance } from "./relevance.js";
import type {
  ArchivedResult,
  ExtractionArchive,
  ExtractionArchiveRecord,
  SearchArchive,
  SearchArchiveRecord,
} from "./archive.js";
import type { EngineFailureKind, EngineSearchOutcome, MergedSearchResponse, SearchResult } from "./types.js";
import { defaultStorePath, searchArchiveEnabled } from "./paths.js";

/** Current SQLite schema. Future changes are appended as numbered migrations. */
export const ARCHIVE_SCHEMA_VERSION = 2;
/** Wait briefly for another API/CLI process holding the shared database lock. */
export const ARCHIVE_BUSY_TIMEOUT_MS = 5_000;

/**
 * A local SQLite archive for completed fan-outs.
 *
 * `node:sqlite` exposes a synchronous connection, so opening it is deferred
 * until the first background write. The registry schedules that write after it
 * has resolved a search, keeping archive I/O out of the result path.
 */
export class SqliteSearchArchive implements SearchArchive, ExtractionArchive, ArchiveInsights {
  readonly #path: string;
  #database: DatabaseSync | undefined;
  #opening: Promise<DatabaseSync> | undefined;
  #closed = false;

  constructor(filePath = defaultStorePath()) {
    this.#path = filePath;
  }

  get filePath(): string {
    return this.#path;
  }

  async archive(record: SearchArchiveRecord): Promise<void> {
    if (this.#closed) throw new Error("Search archive is closed");

    const db = await this.#open();
    const response = record.response;
    const succeeded = response !== undefined;

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO searches (
          search_id, started_at, query, selected_engine_ids_json, status,
          merged_response_json, took_ms, degraded, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.searchId,
        record.startedAt,
        record.query.query,
        JSON.stringify(record.engineIds),
        succeeded ? "completed" : "failed",
        succeeded ? JSON.stringify(response) : null,
        record.tookMs,
        succeeded ? Number(response.degraded) : null,
        ARCHIVE_SCHEMA_VERSION,
      );

      for (const [position, outcome] of record.outcomes.entries()) {
        this.#insertOutcome(db, record.searchId, position + 1, record.query, outcome);
      }

      db.exec("COMMIT");
    } catch (err) {
      rollback(db);
      throw err;
    }
  }

  /**
   * Resolves a result ref to the result that ref actually named.
   *
   * Reads back the merged response exactly as the caller received it, so the
   * answer is the URL that was shown rather than a reconstruction. Returns
   * undefined for anything that does not resolve — a malformed ref, an
   * unarchived search, a rank past the end of the list, or a stored row whose
   * shape no longer parses.
   */
  async findResult(ref: string): Promise<ArchivedResult | undefined> {
    const parsed = parseResultRef(ref);
    if (!parsed) return undefined;

    const db = await this.#open();
    const row = db.prepare("SELECT merged_response_json FROM searches WHERE search_id = ?").get(parsed.searchId);
    const json = row?.merged_response_json;
    if (typeof json !== "string") return undefined;

    let response: MergedSearchResponse;
    try {
      response = JSON.parse(json) as MergedSearchResponse;
    } catch {
      return undefined;
    }

    const result = response.results?.[parsed.rank - 1];
    // Trust the stored ref over the arithmetic: the rank is only a hint at
    // where to look, and a mismatch means this row is not what was asked for.
    if (!result || result.ref !== ref || typeof result.url !== "string") return undefined;

    return { searchId: parsed.searchId, ref, url: result.url, rank: parsed.rank };
  }

  async recordExtraction(record: ExtractionArchiveRecord): Promise<void> {
    if (this.#closed) throw new Error("Search archive is closed");

    const db = await this.#open();
    db.prepare(
      `INSERT INTO extractions (
        created_at, search_id, result_ref, requested_url, final_url, status, error_kind,
        http_status, content_type, redirects, took_ms, title, domain, language, author,
        published, chars, word_count, truncated, markdown_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.startedAt,
      record.searchId ?? null,
      record.resultRef ?? null,
      record.requestedUrl,
      record.finalUrl ?? null,
      record.status,
      record.errorKind ?? null,
      record.httpStatus ?? null,
      record.contentType ?? null,
      record.redirects ?? null,
      record.tookMs,
      record.title ?? null,
      record.domain ?? null,
      record.language ?? null,
      record.author ?? null,
      record.published ?? null,
      record.chars ?? null,
      record.wordCount ?? null,
      record.truncated === undefined ? null : Number(record.truncated),
      record.markdownSha256 ?? null,
    );
  }

  /**
   * Aggregates each engine's record over the most recent searches.
   *
   * Row-level tallies come from SQL; the merge-derived ones are folded in JS
   * over each stored merged response. Doing the second half in SQL would mean
   * `json_each` across a nested array of arrays for a result no more correct
   * and considerably harder to read — and the window is bounded precisely so
   * that reading it in JS stays cheap. Both halves cover the same window, so
   * every number in a row describes the same set of searches.
   */
  async engineMetrics(options: { window?: number } = {}): Promise<EngineMetricsReport> {
    const window = boundedLimit(options.window, DEFAULT_METRICS_WINDOW);
    const db = await this.#open();

    const searches = db
      .prepare(
        `SELECT search_id, started_at, merged_response_json FROM searches
         ORDER BY started_at DESC, search_id DESC LIMIT ?`,
      )
      .all(window) as unknown as Array<{ search_id: string; started_at: string; merged_response_json: string | null }>;

    const totalSearches = Number(
      (db.prepare("SELECT count(*) AS total FROM searches").get() as { total: number }).total,
    );
    const metrics = new Map<string, MutableMetrics>();
    const latencies = new Map<string, number[]>();
    const at = (engineId: string): MutableMetrics => {
      let entry = metrics.get(engineId);
      if (!entry) {
        entry = blankMetrics(engineId);
        metrics.set(engineId, entry);
        latencies.set(engineId, []);
      }
      return entry;
    };

    for (const row of db.prepare(WINDOWED_ENGINE_RESULTS).all(window) as unknown as EngineResultRow[]) {
      const entry = at(row.engine_id);
      entry.searches++;
      if (row.succeeded) {
        entry.succeeded++;
        latencies.get(row.engine_id)?.push(row.took_ms);
        entry.resultCounts.push(row.result_count);
        if (row.coverage !== null) entry.coverages.push(row.coverage);
        if (row.match !== null) entry.matches.push(row.match);
      } else {
        entry.failed++;
        const kind = (row.error_kind ?? "unknown") as EngineFailureKind;
        entry.failures.set(kind, (entry.failures.get(kind) ?? 0) + 1);
      }
    }

    // Which refs were extracted, so a merged result can be marked as read.
    const extracted = new Set<string>();
    for (const row of db.prepare(WINDOWED_EXTRACTED_REFS).all(window) as Array<{
      search_id: string;
      result_ref: string;
    }>) {
      extracted.add(`${row.search_id}\u0000${row.result_ref}`);
    }

    for (const search of searches) {
      const merged = parseMerged(search.merged_response_json);
      for (const result of merged?.results ?? []) {
        creditMergedResult(result, extracted.has(`${search.search_id}\u0000${result.ref}`), (engineId, field) => {
          at(engineId)[field]++;
        });
      }
    }

    return {
      window: searches.length,
      totalSearches,
      since: searches.at(-1)?.started_at ?? null,
      engines: [...metrics.values()]
        .map((entry) => finalizeMetrics(entry, latencies.get(entry.engineId) ?? []))
        .sort((left, right) => right.returned - left.returned || left.engineId.localeCompare(right.engineId)),
    };
  }

  /** Lists recent searches, newest first, for the dashboard's browser. */
  async recentSearches(options: { limit?: number; before?: string } = {}): Promise<SearchSummary[]> {
    const limit = boundedLimit(options.limit, DEFAULT_SEARCH_PAGE_SIZE);
    const db = await this.#open();

    // Keyset pagination on (started_at, search_id): stable while new searches
    // arrive, where an OFFSET would quietly repeat or skip rows.
    const rows = (options.before
      ? db
          .prepare(
            `SELECT * FROM searches WHERE (started_at, search_id) < (
                 SELECT started_at, search_id FROM searches WHERE search_id = ?
               ) ORDER BY started_at DESC, search_id DESC LIMIT ?`,
          )
          .all(options.before, limit)
      : db
          .prepare("SELECT * FROM searches ORDER BY started_at DESC, search_id DESC LIMIT ?")
          .all(limit)) as unknown as SearchRow[];

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.search_id);
    const outcomes = this.#outcomesFor(db, ids, false);
    const counts = this.#extractionCounts(db, ids);

    return rows.map((row) => this.#summarize(row, outcomes.get(row.search_id) ?? [], counts.get(row.search_id) ?? 0));
  }

  /** Everything stored about one search, including each engine's own page. */
  async searchDetail(searchId: string): Promise<SearchDetail | undefined> {
    const db = await this.#open();
    const row = db.prepare("SELECT * FROM searches WHERE search_id = ?").get(searchId) as unknown as
      SearchRow | undefined;
    if (!row) return undefined;

    const outcomes = this.#outcomesFor(db, [searchId], true).get(searchId) ?? [];
    const extractions = db
      .prepare(
        `SELECT created_at, result_ref, requested_url, final_url, status, error_kind, title, chars, took_ms
         FROM extractions WHERE search_id = ? ORDER BY extraction_id`,
      )
      .all(searchId) as unknown as ExtractionRow[];

    return {
      ...this.#summarize(row, outcomes, extractions.length),
      merged: parseMerged(row.merged_response_json),
      engines: outcomes.map((outcome) => ({ ...outcome, results: outcome.results ?? [] })),
      extractionDetails: extractions.map((extraction): ArchivedExtraction => ({
        createdAt: extraction.created_at,
        resultRef: extraction.result_ref,
        requestedUrl: extraction.requested_url,
        finalUrl: extraction.final_url,
        status: extraction.status,
        errorKind: extraction.error_kind,
        title: extraction.title,
        chars: extraction.chars,
        tookMs: extraction.took_ms,
      })),
    };
  }

  #summarize(row: SearchRow, engines: ArchivedEngineOutcome[], extractions: number): SearchSummary {
    const merged = parseMerged(row.merged_response_json);
    return {
      searchId: row.search_id,
      startedAt: row.started_at,
      query: row.query,
      status: row.status,
      degraded: row.degraded === null ? null : row.degraded === 1,
      tookMs: row.took_ms,
      engineIds: parseJson<string[]>(row.selected_engine_ids_json) ?? [],
      resultCount: merged?.results.length ?? null,
      engines,
      extractions,
    };
  }

  /** Per-engine outcomes for a set of searches, optionally with their pages. */
  #outcomesFor(db: DatabaseSync, searchIds: string[], withResults: boolean): Map<string, ArchivedEngineOutcome[]> {
    const placeholders = searchIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT search_id, engine_id, succeeded, took_ms, result_count, coverage, match, error_kind, error_message
                ${withResults ? ", raw_response_json" : ""}
         FROM engine_results WHERE search_id IN (${placeholders}) ORDER BY engine_position`,
      )
      .all(...searchIds) as unknown as EngineResultRow[];

    const grouped = new Map<string, ArchivedEngineOutcome[]>();
    for (const row of rows) {
      const outcome: ArchivedEngineOutcome = {
        engineId: row.engine_id,
        ok: row.succeeded === 1,
        tookMs: row.took_ms,
        resultCount: row.result_count,
        coverage: row.coverage,
        match: row.match,
        errorKind: (row.error_kind as EngineFailureKind | null) ?? null,
      };
      if (withResults) {
        outcome.error = row.error_message;
        outcome.results = parseJson<{ results?: SearchResult[] }>(row.raw_response_json ?? null)?.results ?? [];
      }
      grouped.set(row.search_id, [...(grouped.get(row.search_id) ?? []), outcome]);
    }
    return grouped;
  }

  #extractionCounts(db: DatabaseSync, searchIds: string[]): Map<string, number> {
    const placeholders = searchIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT search_id, count(*) AS total FROM extractions
         WHERE search_id IN (${placeholders}) GROUP BY search_id`,
      )
      .all(...searchIds) as unknown as Array<{ search_id: string; total: number }>;
    return new Map(rows.map((row) => [row.search_id, Number(row.total)]));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#opening?.catch(() => undefined);
    this.#database?.close();
    this.#database = undefined;
  }

  #insertOutcome(
    db: DatabaseSync,
    searchId: string,
    position: number,
    query: SearchArchiveRecord["query"],
    outcome: EngineSearchOutcome,
  ): void {
    if (outcome.ok) {
      const relevance = assessRelevance(query.query, outcome.response.results);
      db.prepare(
        `INSERT INTO engine_results (
          search_id, engine_id, engine_position, succeeded, took_ms,
          result_count, coverage, match, raw_response_json, error_kind, error_message
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        searchId,
        outcome.engineId,
        position,
        outcome.tookMs,
        outcome.response.results.length,
        relevance.coverage,
        relevance.match,
        JSON.stringify(outcome.response),
      );
      return;
    }

    db.prepare(
      `INSERT INTO engine_results (
        search_id, engine_id, engine_position, succeeded, took_ms,
        result_count, coverage, match, raw_response_json, error_kind, error_message
      ) VALUES (?, ?, ?, 0, ?, 0, NULL, NULL, NULL, ?, ?)`,
    ).run(searchId, outcome.engineId, position, outcome.tookMs, outcome.errorKind, outcome.error);
  }

  async #open(): Promise<DatabaseSync> {
    if (this.#database) return this.#database;
    if (this.#opening) return this.#opening;

    this.#opening = (async () => {
      mkdirSync(path.dirname(this.#path), { recursive: true });
      // Dynamic loading keeps merely importing core browser-free and avoids
      // opening or warning about SQLite until archive work actually begins.
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.#path, {
        enableForeignKeyConstraints: true,
        timeout: ARCHIVE_BUSY_TIMEOUT_MS,
      });

      try {
        // Set the timeout first, so everything after it is patient.
        db.exec(`PRAGMA busy_timeout = ${ARCHIVE_BUSY_TIMEOUT_MS}`);
        // WAL is a persistent property of the file and only has to be set
        // once. Switching journal mode takes an exclusive lock that SQLite
        // refuses to wait for — it answers "database is locked" immediately
        // rather than honoring busy_timeout — so concurrent first starts have
        // losers here. Measured: one failure in sixteen simultaneous opens of
        // a new file. A loser that threw would drop its record for nothing,
        // because the winner has already set WAL on its behalf.
        try {
          db.exec("PRAGMA journal_mode = WAL");
        } catch {
          // Another process is setting it, or already has.
        }
        this.#migrate(db);
        this.#database = db;
        return db;
      } catch (err) {
        db.close();
        throw err;
      } finally {
        this.#opening = undefined;
      }
    })();

    return this.#opening;
  }

  #migrate(db: DatabaseSync): void {
    // Unlocked fast path: the overwhelming case is an already-migrated file,
    // and taking a write lock to discover that would serialize every process
    // start against the shared volume.
    if (this.#schemaVersion(db) === ARCHIVE_SCHEMA_VERSION) return;

    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read under the write lock. The API and CLI share one archive file,
      // so they can reach a brand-new database together; the winner creates
      // the schema and sets user_version in this same transaction. Trusting
      // the unlocked read above would make every loser re-run the DDL and
      // fail with "table searches already exists", silently dropping its
      // record, because archive writes are best-effort.
      const version = this.#schemaVersion(db);
      if (version === ARCHIVE_SCHEMA_VERSION) {
        db.exec("COMMIT");
        return;
      }

      if (version < 1) {
        db.exec(`
          CREATE TABLE searches (
            search_id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            query TEXT NOT NULL,
            selected_engine_ids_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
            merged_response_json TEXT,
            took_ms INTEGER NOT NULL CHECK (took_ms >= 0),
            degraded INTEGER CHECK (degraded IN (0, 1)),
            schema_version INTEGER NOT NULL
          );

          CREATE TABLE engine_results (
            search_id TEXT NOT NULL REFERENCES searches(search_id) ON DELETE CASCADE,
            engine_id TEXT NOT NULL,
            engine_position INTEGER NOT NULL CHECK (engine_position > 0),
            succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
            took_ms INTEGER NOT NULL CHECK (took_ms >= 0),
            result_count INTEGER NOT NULL CHECK (result_count >= 0),
            coverage REAL,
            match REAL,
            raw_response_json TEXT,
            error_kind TEXT,
            error_message TEXT,
            PRIMARY KEY (search_id, engine_id),
            CHECK (
              (succeeded = 1 AND raw_response_json IS NOT NULL AND error_kind IS NULL AND error_message IS NULL) OR
              (succeeded = 0 AND raw_response_json IS NULL AND error_kind IS NOT NULL AND error_message IS NOT NULL)
            )
          );
          CREATE INDEX engine_results_by_engine ON engine_results (engine_id, search_id);

          -- Metadata only. Fetched HTML, rendered DOM and Markdown are never
          -- persisted: this table exists to learn which results agents reach
          -- for, not to become a copy of the web.
          --
          -- Keyed by a surrogate id rather than (search_id, result_ref),
          -- because repeat extraction is the signal. A ref extracted three
          -- times is evidence about the two results ranked above it, and a
          -- unique key over that pair would silently discard it.
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
            -- Search provenance is all-or-nothing: a URL-only extraction has
            -- neither, a ref-correlated one has both.
            CHECK ((search_id IS NULL) = (result_ref IS NULL)),
            CHECK (
              (status = 'completed' AND error_kind IS NULL) OR
              (status = 'failed' AND error_kind IS NOT NULL)
            )
          );
          CREATE INDEX extractions_by_result ON extractions (search_id, result_ref);
          CREATE INDEX extractions_by_domain ON extractions (domain, created_at);
        `);
      }

      if (version < 2) {
        // Every dashboard read opens with "the most recent N searches", and
        // without this SQLite answered it by scanning the whole table into a
        // temporary B-tree to sort — three times per metrics request, growing
        // with the archive. That is precisely the cost the bounded window was
        // meant to avoid, and bounding the window does not help when finding
        // the window is the expensive part.
        //
        // Column order matches the ORDER BY exactly, including the
        // directions, so the index is walked rather than sorted.
        db.exec("CREATE INDEX IF NOT EXISTS searches_recent ON searches (started_at DESC, search_id DESC)");
      }

      db.exec(`PRAGMA user_version = ${ARCHIVE_SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (err) {
      rollback(db);
      throw err;
    }
  }

  /** Reads the file's schema version, refusing one this build cannot read. */
  #schemaVersion(db: DatabaseSync): number {
    const row = db.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version ?? 0);
    if (version > ARCHIVE_SCHEMA_VERSION) {
      throw new Error(`Search archive schema ${version} is newer than supported version ${ARCHIVE_SCHEMA_VERSION}`);
    }
    return version;
  }
}

/** Preserve the original database error when rollback itself cannot run. */
function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction may never have started, or the connection may be gone.
  }
}

/** Creates the default archive unless the process explicitly disables it. */
export function createDefaultSearchArchive(): SqliteSearchArchive | undefined {
  return searchArchiveEnabled() ? new SqliteSearchArchive() : undefined;
}

/** Engine rows for the most recent N searches, ordered by that same window. */
const WINDOWED_ENGINE_RESULTS = `
  SELECT e.search_id, e.engine_id, e.succeeded, e.took_ms, e.result_count,
         e.coverage, e.match, e.error_kind, e.error_message
  FROM engine_results e
  JOIN (SELECT search_id FROM searches ORDER BY started_at DESC, search_id DESC LIMIT ?) w
    ON w.search_id = e.search_id
`;

/** Refs extracted at least once, within that same window. */
const WINDOWED_EXTRACTED_REFS = `
  SELECT DISTINCT x.search_id, x.result_ref
  FROM extractions x
  JOIN (SELECT search_id FROM searches ORDER BY started_at DESC, search_id DESC LIMIT ?) w
    ON w.search_id = x.search_id
  WHERE x.result_ref IS NOT NULL AND x.status = 'completed'
`;

interface SearchRow {
  search_id: string;
  started_at: string;
  query: string;
  selected_engine_ids_json: string;
  status: "completed" | "failed";
  merged_response_json: string | null;
  took_ms: number;
  degraded: number | null;
}

interface EngineResultRow {
  search_id: string;
  engine_id: string;
  succeeded: number;
  took_ms: number;
  result_count: number;
  coverage: number | null;
  match: number | null;
  error_kind: string | null;
  error_message: string | null;
  raw_response_json?: string | null;
}

interface ExtractionRow {
  created_at: string;
  result_ref: string | null;
  requested_url: string;
  final_url: string | null;
  status: "completed" | "failed";
  error_kind: string | null;
  title: string | null;
  chars: number | null;
  took_ms: number;
}

interface MutableMetrics {
  engineId: string;
  searches: number;
  succeeded: number;
  failed: number;
  failures: Map<EngineFailureKind, number>;
  resultCounts: number[];
  coverages: number[];
  matches: number[];
  returned: number;
  bestSource: number;
  soleFinder: number;
  extracted: number;
}

function blankMetrics(engineId: string): MutableMetrics {
  return {
    engineId,
    searches: 0,
    succeeded: 0,
    failed: 0,
    failures: new Map(),
    resultCounts: [],
    coverages: [],
    matches: [],
    returned: 0,
    bestSource: 0,
    soleFinder: 0,
    extracted: 0,
  };
}

function finalizeMetrics(entry: MutableMetrics, latencies: number[]): EngineMetrics {
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    engineId: entry.engineId,
    searches: entry.searches,
    succeeded: entry.succeeded,
    failed: entry.failed,
    failures: [...entry.failures]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    medianTookMs: percentile(sorted, 0.5),
    p95TookMs: percentile(sorted, 0.95),
    meanResultCount: mean(entry.resultCounts),
    meanCoverage: mean(entry.coverages),
    meanMatch: mean(entry.matches),
    returned: entry.returned,
    bestSource: entry.bestSource,
    soleFinder: entry.soleFinder,
    extracted: entry.extracted,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

/** A stored row that no longer parses is skipped, never a read failure. */
function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseMerged(value: string | null): MergedSearchResponse | null {
  return parseJson<MergedSearchResponse>(value) ?? null;
}

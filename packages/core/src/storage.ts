import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
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
  type ExtractionTotals,
  type OverloadTotals,
  type SearchDetail,
  type SearchSummary,
  type SearchTotals,
} from "./insights.js";
import { canonicalizeUrl } from "./ranking.js";
import { assessRelevance } from "./relevance.js";
import type { ExtractionArchive, ExtractionArchiveRecord, SearchArchive, SearchArchiveRecord } from "./archive.js";
import type { EngineFailureKind, EngineSearchOutcome, MergedSearchResponse, SearchResult } from "./types.js";
import { defaultStorePath, searchArchiveEnabled } from "./paths.js";

/** Current SQLite schema. Future changes are appended as numbered migrations. */
export const ARCHIVE_SCHEMA_VERSION = 5;
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

  async recordExtraction(record: ExtractionArchiveRecord): Promise<void> {
    if (this.#closed) throw new Error("Search archive is closed");

    const db = await this.#open();
    db.prepare(
      `INSERT INTO extractions (
        created_at, requested_url, final_url, status, error_kind,
        http_status, content_type, redirects, took_ms, title, domain, language, author,
        published, chars, word_count, truncated, markdown_sha256, cached, degraded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.startedAt,
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
      record.cached === undefined ? null : Number(record.cached),
      record.degradedBy ?? null,
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
  async engineMetrics(options: { window?: number; overload?: OverloadTotals } = {}): Promise<EngineMetricsReport> {
    const window = boundedLimit(options.window, DEFAULT_METRICS_WINDOW);
    const db = await this.#open();

    const searchRows = rows<WindowedSearchRow>(
      db.prepare(
        `SELECT search_id, started_at, merged_response_json FROM searches
         ORDER BY started_at DESC, search_id DESC LIMIT ?`,
      ),
      window,
    );
    const searches = searchRows;
    // Needed before the loops below, which match reads to results by URL.
    const since = searches.at(-1)?.started_at ?? null;

    // count(*) always returns a row; ?? 0 is so an unreachable absence reads
    // as zero rather than reaching the response as NaN.
    const totalSearches = Number(
      firstRow<{ total: number }>(db.prepare("SELECT count(*) AS total FROM searches"))?.total ?? 0,
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

    for (const row of rows<EngineResultRow>(db.prepare(WINDOWED_ENGINE_RESULTS), window)) {
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

    // Which URLs were read, so a merged result can be marked as read. Matched
    // on the canonical form, because the URL a caller extracted is the one a
    // result gave it, and those differ in the ways canonicalizeUrl forgives.
    const extracted = new Set<string>();
    for (const row of rows<ExtractedUrlRow>(db.prepare(WINDOWED_EXTRACTED_URLS), since ?? "")) {
      extracted.add(canonicalizeUrl(row.requested_url));
      if (row.final_url) extracted.add(canonicalizeUrl(row.final_url));
    }

    for (const search of searches) {
      const merged = parseMerged(search.merged_response_json);
      for (const result of merged?.results ?? []) {
        creditMergedResult(result, extracted.has(canonicalizeUrl(result.url)), (engineId, field) => {
          at(engineId)[field]++;
        });
      }
    }

    return {
      window: searches.length,
      totalSearches,
      since,
      searches: this.#searchTotals(searches),
      extractions: this.#extractionTotals(db, since),
      ...(options.overload ? { overload: options.overload } : {}),
      engines: [...metrics.values()]
        .map((entry) => finalizeMetrics(entry, latencies.get(entry.engineId) ?? []))
        .sort((left, right) => right.returned - left.returned || left.engineId.localeCompare(right.engineId)),
    };
  }

  /** How the window's fan-outs ended, read off the rows already in hand. */
  #searchTotals(rows: WindowedSearchRow[]): SearchTotals {
    const totals: SearchTotals = { completed: 0, failed: 0, degraded: 0 };
    for (const row of rows) {
      const merged = parseMerged(row.merged_response_json);
      if (merged) {
        totals.completed++;
        if (merged.degraded) totals.degraded++;
      } else {
        totals.failed++;
      }
    }
    return totals;
  }

  /**
   * Extractions over the window's period.
   *
   * Bounded by time rather than joined to the window's searches, because a
   * bare-URL extraction has no search to join to and dropping those would
   * make the number quietly answer a different question.
   */
  #extractionTotals(db: DatabaseSync, since: string | null): ExtractionTotals {
    const empty: ExtractionTotals = {
      attempted: 0,
      completed: 0,
      failed: 0,
      failures: [],
      cached: 0,
      medianTookMs: null,
      meanChars: null,
      domains: 0,
    };
    if (since === null) return empty;

    const summary = firstRow<{
      attempted: number;
      completed: number;
      failed: number;
      cached: number;
      domains: number;
      chars: number | null;
    }>(
      db.prepare(`SELECT
           count(*) AS attempted,
           sum(status = 'completed') AS completed,
           sum(status = 'failed') AS failed,
           sum(cached = 1) AS cached,
           count(DISTINCT domain) AS domains,
           avg(chars) AS chars
         FROM extractions WHERE created_at >= ?`),
      since,
    );
    if (!summary || Number(summary.attempted) === 0) return empty;

    const kinds = rows<{ error_kind: string | null; n: number }>(
      db.prepare(`SELECT error_kind, count(*) AS n FROM extractions
                  WHERE created_at >= ? AND status = 'failed'
                  GROUP BY error_kind ORDER BY n DESC, error_kind`),
      since,
    );

    // `cached IS NOT 1` rather than `cached = 0`: rows written before the
    // column existed are NULL, and for as long as there was no cache they
    // were all renders.
    const took = rows<{ took_ms: number }>(
      db.prepare(`SELECT took_ms FROM extractions
                  WHERE created_at >= ? AND status = 'completed' AND cached IS NOT 1
                  ORDER BY took_ms`),
      since,
    ).map((row) => row.took_ms);

    return {
      attempted: Number(summary.attempted),
      completed: Number(summary.completed ?? 0),
      failed: Number(summary.failed ?? 0),
      failures: kinds.map((row) => ({ kind: row.error_kind ?? "unknown", count: Number(row.n) })),
      cached: Number(summary.cached ?? 0),
      medianTookMs: percentile(took, 0.5),
      meanChars: summary.chars === null ? null : round(Number(summary.chars)),
      domains: Number(summary.domains),
    };
  }

  /** Lists recent searches, newest first, for the dashboard's browser. */
  async recentSearches(options: { limit?: number; before?: string } = {}): Promise<SearchSummary[]> {
    const limit = boundedLimit(options.limit, DEFAULT_SEARCH_PAGE_SIZE);
    const db = await this.#open();

    // Keyset pagination on (started_at, search_id): stable while new searches
    // arrive, where an OFFSET would quietly repeat or skip rows.
    const page = options.before
      ? rows<SearchRow>(
          db.prepare(
            `SELECT * FROM searches WHERE (started_at, search_id) < (
                 SELECT started_at, search_id FROM searches WHERE search_id = ?
               ) ORDER BY started_at DESC, search_id DESC LIMIT ?`,
          ),
          options.before,
          limit,
        )
      : rows<SearchRow>(db.prepare("SELECT * FROM searches ORDER BY started_at DESC, search_id DESC LIMIT ?"), limit);

    if (page.length === 0) return [];

    const outcomes = this.#outcomesFor(
      db,
      page.map((row) => row.search_id),
      false,
    );
    const extractions = this.#extractionsFor(db, page);

    return page.map((row) =>
      this.#summarize(row, outcomes.get(row.search_id) ?? [], extractions.get(row.search_id)?.length ?? 0),
    );
  }

  /** Everything stored about one search, including each engine's own page. */
  async searchDetail(searchId: string): Promise<SearchDetail | undefined> {
    const db = await this.#open();
    const row = firstRow<SearchRow>(db.prepare("SELECT * FROM searches WHERE search_id = ?"), searchId);
    if (!row) return undefined;

    const outcomes = this.#outcomesFor(db, [searchId], true).get(searchId) ?? [];
    const extractions = this.#extractionsFor(db, [row]).get(searchId) ?? [];

    return {
      ...this.#summarize(row, outcomes, extractions.length),
      merged: parseMerged(row.merged_response_json),
      engines: outcomes.map((outcome) => ({ ...outcome, results: outcome.results ?? [] })),
      extractionDetails: extractions.map((extraction): ArchivedExtraction => ({
        createdAt: extraction.created_at,
        requestedUrl: extraction.requested_url,
        finalUrl: extraction.final_url,
        status: extraction.status,
        errorKind: extraction.error_kind,
        title: extraction.title,
        chars: extraction.chars,
        tookMs: extraction.took_ms,
        cached: extraction.cached === null ? null : extraction.cached === 1,
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
    // `IN ()` is a syntax error, not an empty result. Callers happen to guard
    // this today; the guard belongs with the SQL that needs it.
    if (searchIds.length === 0) return new Map();

    const placeholders = searchIds.map(() => "?").join(", ");
    const found = rows<EngineResultRow>(
      db.prepare(
        `SELECT search_id, engine_id, succeeded, took_ms, result_count, coverage, match, error_kind, error_message
                ${withResults ? ", raw_response_json" : ""}
         FROM engine_results WHERE search_id IN (${placeholders}) ORDER BY engine_position`,
      ),
      ...searchIds,
    );

    const grouped = new Map<string, ArchivedEngineOutcome[]>();
    for (const row of found) {
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
      const group = grouped.get(row.search_id);
      if (group) group.push(outcome);
      else grouped.set(row.search_id, [outcome]);
    }
    return grouped;
  }

  /**
   * Matches archived extractions back to the searches that offered their URLs.
   *
   * Worked out at read time rather than recorded. An extraction stores only
   * the URL it read, so a search that returned that URL before the read is
   * taken to be where the caller got it. That is best-effort by construction:
   * a URL read for unrelated reasons is still credited to a search that
   * happened to surface it, and where several did, the most recent one wins.
   * Fine for a signal that already means "someone read this", not "this read
   * was caused by that ranking".
   *
   * Only the searches passed in can win a match, so a page of searches is
   * scored against itself rather than against all of history.
   */
  #extractionsFor(db: DatabaseSync, searches: SearchRow[]): Map<string, ExtractionRow[]> {
    const offered = new Map<string, { searchId: string; startedAt: string }[]>();
    let earliest: string | undefined;
    for (const row of searches) {
      if (earliest === undefined || row.started_at < earliest) earliest = row.started_at;
      for (const result of parseMerged(row.merged_response_json)?.results ?? []) {
        const key = canonicalizeUrl(result.url);
        const group = offered.get(key);
        if (group) group.push({ searchId: row.search_id, startedAt: row.started_at });
        else offered.set(key, [{ searchId: row.search_id, startedAt: row.started_at }]);
      }
    }
    if (earliest === undefined || offered.size === 0) return new Map();

    const matched = new Map<string, ExtractionRow[]>();
    for (const extraction of rows<ExtractionRow>(db.prepare(EXTRACTIONS_SINCE), earliest)) {
      // Either URL may be the one a search showed: engines link the address
      // that redirects as often as the one it lands on.
      const candidates =
        offered.get(canonicalizeUrl(extraction.requested_url)) ??
        (extraction.final_url === null ? undefined : offered.get(canonicalizeUrl(extraction.final_url)));
      if (!candidates) continue;

      let best: { searchId: string; startedAt: string } | undefined;
      for (const candidate of candidates) {
        if (candidate.startedAt > extraction.created_at) continue;
        if (!best || candidate.startedAt > best.startedAt) best = candidate;
      }
      if (!best) continue;

      const group = matched.get(best.searchId);
      if (group) group.push(extraction);
      else matched.set(best.searchId, [extraction]);
    }
    return matched;
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
    // Checked here rather than at each entry point, so a read cannot quietly
    // reopen the file a moment after close() shut it. Writes always refused;
    // reads used to open a second connection and go on working, which made
    // "closed" mean two different things depending on the method called.
    if (this.#closed) throw new Error("Search archive is closed");
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

      if (version < 3) {
        // A read served from the page cache takes about a millisecond and a
        // rendered one about five seconds, so a median over both describes
        // neither. Rows written before this column existed stay NULL, which
        // is honest — "not recorded" rather than a guess — and the queries
        // below treat anything that is not a 1 as a render, which is what
        // those rows were for as long as there was no cache.
        db.exec("ALTER TABLE extractions ADD COLUMN cached INTEGER CHECK (cached IN (0, 1))");
      }

      if (version < 4) {
        // `ref` is gone from the API, so the columns that stored it go too.
        // A read is now matched to the search that offered it by URL, at the
        // point the dashboard asks — which is the operator's question, and so
        // not something a caller should have had to remember to answer.
        //
        // A rebuild rather than DROP COLUMN: both columns appear in a CHECK
        // constraint, and SQLite refuses to drop a column a constraint
        // mentions. Verified, not assumed.
        db.exec(`
          CREATE TABLE extractions_v4 (
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
            CHECK (
              (status = 'completed' AND error_kind IS NULL) OR
              (status = 'failed' AND error_kind IS NOT NULL)
            )
          );
          INSERT INTO extractions_v4 (
            extraction_id, created_at, requested_url, final_url, status, error_kind, http_status,
            content_type, redirects, took_ms, title, domain, language, author, published, chars,
            word_count, truncated, markdown_sha256, cached
          ) SELECT
            extraction_id, created_at, requested_url, final_url, status, error_kind, http_status,
            content_type, redirects, took_ms, title, domain, language, author, published, chars,
            word_count, truncated, markdown_sha256, cached
          FROM extractions;
          DROP TABLE extractions;
          ALTER TABLE extractions_v4 RENAME TO extractions;
          CREATE INDEX extractions_by_domain ON extractions (domain, created_at);
          -- Correlation reads every extraction since the oldest search on the
          -- page and matches URLs in JS, so the range scan is what needs the
          -- index; the URLs themselves are never a WHERE clause.
          CREATE INDEX extractions_recent ON extractions (created_at);
        `);
      }

      if (version < 5) {
        // A render that ran out of transfer budget or request count returns
        // the document it had rather than failing, so nothing else in this
        // table distinguishes a page that was genuinely thin from one this
        // server stopped fetching. Rows written before the column existed
        // stay NULL, which is the honest answer for them: the renders they
        // describe could not be degraded, because a render that hit either
        // bound failed outright instead.
        db.exec("ALTER TABLE extractions ADD COLUMN degraded_by TEXT CHECK (degraded_by IN ('bytes', 'requests'))");
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

/**
 * URLs read at least once over the window's period.
 *
 * Bounded by time rather than joined to the window's searches, because an
 * extraction no longer records which search it came from — it is matched back
 * by URL, in JS, where the merged responses are already being walked.
 */
/** Every extraction from a period, for matching back to searches by URL. */
const EXTRACTIONS_SINCE = `
  SELECT created_at, requested_url, final_url, status, error_kind, title, chars, took_ms, cached
  FROM extractions WHERE created_at >= ? ORDER BY extraction_id
`;

const WINDOWED_EXTRACTED_URLS = `
  SELECT DISTINCT requested_url, final_url FROM extractions
  WHERE status = 'completed' AND created_at >= ?
`;

/**
 * Reads rows as one of the shapes declared below.
 *
 * The double cast is not avoidable and not laziness: node:sqlite types every
 * row as `Record<string, SQLOutputValue>`, which has no overlap with these
 * interfaces, so a single `as` will not compile. Going through `unknown` in
 * one place beats seven, and gives the assertion somewhere to be explained.
 *
 * What is being asserted is real work: these interfaces track the DDL in
 * #migrate by hand, and nothing checks that they still agree. A column
 * renamed there is a silent `undefined` here.
 */
function rows<T>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as unknown as T[];
}

/** The single-row form of {@link rows}. */
function firstRow<T>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as unknown as T | undefined;
}

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

/** The three columns engineMetrics reads from each search in its window. */
interface WindowedSearchRow {
  search_id: string;
  started_at: string;
  merged_response_json: string | null;
}

/** One URL read at least once over the window's period. */
interface ExtractedUrlRow {
  requested_url: string;
  final_url: string | null;
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
  requested_url: string;
  final_url: string | null;
  status: "completed" | "failed";
  error_kind: string | null;
  title: string | null;
  chars: number | null;
  took_ms: number;
  cached: number | null;
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

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseResultRef } from "./ranking.js";
import { assessRelevance } from "./relevance.js";
import type {
  ArchivedResult,
  ExtractionArchive,
  ExtractionArchiveRecord,
  SearchArchive,
  SearchArchiveRecord,
} from "./archive.js";
import type { EngineSearchOutcome, MergedSearchResponse } from "./types.js";
import { defaultStorePath, searchArchiveEnabled } from "./paths.js";

/** Current SQLite schema. Future changes are appended as numbered migrations. */
export const ARCHIVE_SCHEMA_VERSION = 1;
/** Wait briefly for another API/CLI process holding the shared database lock. */
export const ARCHIVE_BUSY_TIMEOUT_MS = 5_000;

/**
 * A local SQLite archive for completed fan-outs.
 *
 * `node:sqlite` exposes a synchronous connection, so opening it is deferred
 * until the first background write. The registry schedules that write after it
 * has resolved a search, keeping archive I/O out of the result path.
 */
export class SqliteSearchArchive implements SearchArchive, ExtractionArchive {
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

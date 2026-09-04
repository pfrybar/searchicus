import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assessRelevance } from "./relevance.js";
import type { SearchArchive, SearchArchiveRecord } from "./archive.js";
import type { EngineSearchOutcome } from "./types.js";
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
export class SqliteSearchArchive implements SearchArchive {
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
        db.exec("PRAGMA journal_mode = WAL");
        db.exec(`PRAGMA busy_timeout = ${ARCHIVE_BUSY_TIMEOUT_MS}`);
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
    const row = db.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version ?? 0);
    if (version > ARCHIVE_SCHEMA_VERSION) {
      throw new Error(`Search archive schema ${version} is newer than supported version ${ARCHIVE_SCHEMA_VERSION}`);
    }
    if (version === ARCHIVE_SCHEMA_VERSION) return;

    db.exec("BEGIN IMMEDIATE");
    try {
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

          CREATE TABLE extractions (
            search_id TEXT NOT NULL REFERENCES searches(search_id) ON DELETE CASCADE,
            result_ref TEXT NOT NULL,
            url TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            content_text TEXT,
            error_message TEXT,
            PRIMARY KEY (search_id, result_ref)
          );
        `);
      }
      db.exec(`PRAGMA user_version = ${ARCHIVE_SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (err) {
      rollback(db);
      throw err;
    }
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

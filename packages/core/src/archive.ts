import type { EngineSearchOutcome, MergedSearchResponse, SearchQuery } from "./types.js";

/**
 * A durable snapshot of one complete fan-out. It exists independently of the
 * client response so total failures are still useful reliability records.
 */
export interface SearchArchiveRecord {
  /** The opaque id generated before the fan-out starts. */
  readonly searchId: string;
  /** When the fan-out began, in ISO-8601 UTC. */
  readonly startedAt: string;
  readonly query: SearchQuery;
  /** The explicit selection, or the resolved default engine list. */
  readonly engineIds: readonly string[];
  /** Raw outcomes retained for diagnostics and later analysis. */
  readonly outcomes: readonly EngineSearchOutcome[];
  /** Undefined only when every selected engine failed. */
  readonly response?: MergedSearchResponse;
  /** Total elapsed fan-out time, including any throttle wait. */
  readonly tookMs: number;
}

/**
 * Receives background archive work from a registry. Implementations must not
 * assume their failures are delivered to a search caller: the registry makes
 * persistence deliberately best-effort.
 */
export interface SearchArchive {
  archive(record: SearchArchiveRecord): Promise<void>;
  /** Called after pending archive jobs have drained, if cleanup is needed. */
  close?(): Promise<void>;
}

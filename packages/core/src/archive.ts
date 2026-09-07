import type { ExtractFailureKind, RenderDegradation } from "./extract/types.js";
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

/** A durable record of one extraction attempt. Metadata only, never content. */
export interface ExtractionArchiveRecord {
  readonly startedAt: string;
  readonly requestedUrl: string;
  readonly finalUrl?: string;
  readonly status: "completed" | "failed";
  readonly errorKind?: ExtractFailureKind;
  readonly httpStatus?: number;
  readonly contentType?: string;
  readonly redirects?: number;
  readonly tookMs: number;
  readonly title?: string;
  readonly domain?: string;
  readonly language?: string;
  readonly author?: string;
  readonly published?: string;
  /** Length of the Markdown returned to the caller. */
  readonly chars?: number;
  readonly wordCount?: number;
  readonly truncated?: boolean;
  /**
   * Digest of the returned Markdown. Lets two extractions be compared for
   * sameness — a page that changed, a soft 404 served identically everywhere
   * — without keeping the text itself.
   */
  readonly markdownSha256?: string;
  /**
   * Whether this read was served from the page cache rather than rendered.
   *
   * Recorded because the two are three orders of magnitude apart — 1ms
   * against 5,900ms for the same document — so a timing that mixes them
   * describes neither.
   */
  readonly cached?: boolean;
  /**
   * Which bound, if any, stopped the render fetching before the page had
   * finished loading. See RenderDegradation.
   *
   * Recorded because it is the missing half of a thin result. A page that
   * extracts to almost nothing is either a bot wall, a JavaScript shell, or a
   * render that was cut off — and only the last of those is this server's
   * doing. Absent on a read served from cache before this column existed, and
   * absent on any render that completed normally.
   */
  readonly degradedBy?: RenderDegradation;
}

/**
 * The archive surface extraction needs: one write.
 *
 * Separate from SearchArchive because the two have genuinely different
 * dependencies — a registry never writes an extraction, the extraction
 * service never writes a fan-out — and because a deployment with archiving
 * off must still be able to extract.
 */
export interface ExtractionArchive {
  recordExtraction(record: ExtractionArchiveRecord): Promise<void>;
  close?(): Promise<void>;
}

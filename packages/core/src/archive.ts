import type { ExtractFailureKind } from "./extract/types.js";
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

/** One result as it was actually shown, recovered from an archived search. */
export interface ArchivedResult {
  readonly searchId: string;
  readonly ref: string;
  /** The URL the caller saw for this ref, not a canonicalized form of it. */
  readonly url: string;
  /** 1-based position in the merged list. */
  readonly rank: number;
}

/** A durable record of one extraction attempt. Metadata only, never content. */
export interface ExtractionArchiveRecord {
  readonly startedAt: string;
  /** Search provenance, present together or not at all. */
  readonly searchId?: string;
  readonly resultRef?: string;
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
}

/**
 * The archive surface extraction needs: one read, to prove a ref really names
 * the URL being extracted, and one write.
 *
 * Separate from SearchArchive because the two have genuinely different
 * dependencies — a registry never reads, and the extraction service never
 * writes a fan-out — and because a deployment with archiving off must still
 * be able to extract bare URLs.
 */
export interface ExtractionArchive {
  /** The result a ref names, or undefined if no archived search has it. */
  findResult(ref: string): Promise<ArchivedResult | undefined>;
  recordExtraction(record: ExtractionArchiveRecord): Promise<void>;
  close?(): Promise<void>;
}

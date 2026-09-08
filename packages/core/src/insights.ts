import type { RankedResult } from "./ranking.js";
import type { EngineFailureKind, MergedSearchResponse, SearchResult } from "./types.js";

/**
 * How many recent searches the metrics summarize by default.
 *
 * Bounded on purpose. An archive grows without limit, and a dashboard that
 * slows down as it collects more data stops being opened — but more
 * importantly, "how is Startpage doing" is a question about the recent past.
 * Averaging over a selector change six months ago answers nothing useful.
 */
export const DEFAULT_METRICS_WINDOW = 500;
/** Searches listed per page of the browser. */
export const DEFAULT_SEARCH_PAGE_SIZE = 50;
/** Ceiling on both, so a caller cannot ask the process to read everything. */
export const MAX_INSIGHTS_LIMIT = 2_000;

/** One engine's record over the examined window. */
export interface EngineMetrics {
  engineId: string;
  /** Fan-outs this engine took part in. */
  searches: number;
  succeeded: number;
  failed: number;
  /** Failure counts by category, most frequent first. */
  failures: Array<{ kind: EngineFailureKind; count: number }>;
  /** Milliseconds; null when the engine never succeeded in the window. */
  medianTookMs: number | null;
  p95TookMs: number | null;
  /** Averages across successful runs only; a failure has nothing to average. */
  meanResultCount: number | null;
  /** Mean query-token coverage of this engine's own page. See relevance.ts. */
  meanCoverage: number | null;
  meanMatch: number | null;
  /**
   * Merged results this engine found. The question the ranking layer cannot
   * answer on its own: how much of what callers actually saw came from here.
   */
  returned: number;
  /** Merged results where this engine supplied the displayed title and URL. */
  bestSource: number;
  /**
   * Merged results **only** this engine found.
   *
   * The number that decides whether an engine earns its seconds. An engine
   * that agrees with three others is cheap to drop; one that alone surfaces
   * results that reach callers is not.
   */
  soleFinder: number;
  /**
   * Merged results this engine found that someone later extracted.
   *
   * An agent choosing to read a result is the closest thing here to a
   * relevance judgement — with the caveat that it is a click model, and rank
   * 1 gets chosen more often regardless of quality.
   */
  extracted: number;
}

/** Per-engine metrics plus the window they describe. */
/** How the fan-outs in the window ended, whatever the engines did inside them. */
export interface SearchTotals {
  /** Fan-outs that returned a ranked list. */
  completed: number;
  /** Fan-outs where every selected engine failed. */
  failed: number;
  /** Completed, but with at least one engine missing from the answer. */
  degraded: number;
}

/** What was read back out of the pages this window's searches offered. */
export interface ExtractionTotals {
  attempted: number;
  completed: number;
  /** Pages rendered successfully but withheld as unusable. */
  unusable: number;
  unusableReasons: Array<{ kind: string; count: number }>;
  failed: number;
  /** Failure kinds, commonest first. Never includes this server's own load. */
  failures: Array<{ kind: string; count: number }>;
  /** Completed reads served from the page cache rather than rendered. */
  cached: number;
  /**
   * Median time of a read that actually rendered.
   *
   * Cached reads are excluded rather than averaged in. They are about a
   * millisecond against about five seconds, so a median over both answers
   * neither "how long does reading a page take" nor "how fast is the cache" —
   * it just drifts downward as the cache warms.
   */
  medianTookMs: number | null;
  meanChars: number | null;
  /** Distinct hosts read, a rough measure of breadth rather than volume. */
  domains: number;
}

/**
 * Work this process refused or gave up on, since it started.
 *
 * Deliberately not from the archive: these never reached an engine or a
 * page, so archiving them would put the server's own load into tables that
 * describe engines and documents. That does mean they reset on restart,
 * unlike every other number here, and a reader has to be told so.
 */
export interface OverloadTotals {
  search: { refused: number; abandoned: number };
  extract: { refused: number; abandoned: number };
}

export interface EngineMetricsReport {
  /** Searches actually examined. */
  window: number;
  /** Searches in the archive, so a truncated window is visible as such. */
  totalSearches: number;
  /** Timestamp of the oldest search in the window, ISO-8601. */
  since: string | null;
  /** How the window's fan-outs ended. */
  searches: SearchTotals;
  /** Extractions over the same period. */
  extractions: ExtractionTotals;
  engines: EngineMetrics[];
  /**
   * Refusals by this process, when the caller supplied them. Absent from a
   * bare archive read, which has no process to ask.
   */
  overload?: OverloadTotals;
}

/** One engine's outcome, as listed beside a search. */
export interface ArchivedEngineOutcome {
  engineId: string;
  ok: boolean;
  tookMs: number;
  resultCount: number;
  coverage: number | null;
  match: number | null;
  errorKind: EngineFailureKind | null;
  /** Diagnostic text for a failure. Absent from list views. */
  error?: string | null;
  /** The engine's own page, in its own order. Only in a detail view. */
  results?: SearchResult[];
}

/** A search as it appears in a list. */
export interface SearchSummary {
  searchId: string;
  startedAt: string;
  query: string;
  status: "completed" | "failed";
  degraded: boolean | null;
  tookMs: number;
  engineIds: string[];
  /** Results in the merged list; null when every engine failed. */
  resultCount: number | null;
  engines: ArchivedEngineOutcome[];
  extractions: number;
}

/** One archived extraction, matched by URL to the search it came from. */
export interface ArchivedExtraction {
  createdAt: string;
  requestedUrl: string;
  finalUrl: string | null;
  status: "completed" | "unusable" | "failed";
  errorKind: string | null;
  unusableKind: string | null;
  httpStatus: number | null;
  title: string | null;
  chars: number | null;
  tookMs: number;
  /** Null for reads recorded before this was tracked. */
  cached: boolean | null;
}

/** Everything stored about one search: what each engine said, and what shipped. */
export interface SearchDetail extends SearchSummary {
  /** The detailed internal ranking retained for operators. Null when every engine failed. */
  merged: MergedSearchResponse | null;
  /** Every result each engine returned, in its own order. */
  engines: Array<ArchivedEngineOutcome & { results: SearchResult[] }>;
  extractionDetails: ArchivedExtraction[];
}

/**
 * Read access to the archive, for dashboards and analysis.
 *
 * Separate from SearchArchive and ExtractionArchive because it is a different
 * job with a different risk: those two are narrow write paths taken during a
 * request, while this reads accumulated history — queries, result text, and
 * URLs. Anything serving these results is exposing a record of what has been
 * searched for, which deserves more thought than a result list does.
 */
export interface ArchiveInsights {
  engineMetrics(options?: { window?: number; overload?: OverloadTotals }): Promise<EngineMetricsReport>;
  recentSearches(options?: { limit?: number; before?: string }): Promise<SearchSummary[]>;
  searchDetail(searchId: string): Promise<SearchDetail | undefined>;
}

/** How much of the archive the dashboard may read at a time. */
export interface DashboardConfig {
  /** Recent searches averaged over for engine metrics. */
  readonly metricsWindow: number;
  /** Searches listed per page of the browser. */
  readonly searchPageSize: number;
  /** Ceiling on both, so a caller cannot ask the process to read everything. */
  readonly maxLimit: number;
}

/** The built-in dashboard window sizes, for callers that configure nothing. */
export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  metricsWindow: DEFAULT_METRICS_WINDOW,
  searchPageSize: DEFAULT_SEARCH_PAGE_SIZE,
  maxLimit: MAX_INSIGHTS_LIMIT,
};

/**
 * Clamps a caller-supplied limit into a range the process will actually read.
 *
 * The ceiling applies to the fallback too. Asking for nothing is still a read
 * of the archive, and a default above the maximum would be the one query that
 * ignored it — which is exactly the query the dashboard makes.
 */
export function boundedLimit(value: number | undefined, fallback: number, max = MAX_INSIGHTS_LIMIT): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return Math.min(fallback, max);
  return Math.min(value, max);
}

/**
 * Nearest-rank percentile over already-sorted ascending values.
 *
 * Nearest-rank rather than interpolated: these are observed request times, and
 * a p95 that is a real measurement beats one that averages two.
 */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Rounds to a fixed precision, keeping JSON responses readable. */
export function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Folds one merged result into the per-engine tallies.
 *
 * Attribution is by `found`, not by `bestSource`: every engine that surfaced
 * a result contributed to it reaching the caller, even though only one
 * supplied the title shown.
 */
export function creditMergedResult(
  result: RankedResult,
  extracted: boolean,
  credit: (engineId: string, field: "returned" | "bestSource" | "soleFinder" | "extracted") => void,
): void {
  const finders = result.found ?? [];
  for (const { engineId } of finders) {
    credit(engineId, "returned");
    if (extracted) credit(engineId, "extracted");
  }

  if (result.bestSource) credit(result.bestSource, "bestSource");
  if (finders.length === 1 && finders[0]) credit(finders[0].engineId, "soleFinder");
}

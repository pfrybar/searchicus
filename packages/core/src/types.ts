import type { SearchContext } from "./context.js";
import type { RankedResult } from "./ranking.js";

/** A search request, independent of which engine(s) it's sent to. */
export interface SearchQuery {
  /** The normalized search text entered into an engine's ordinary search box. */
  query: string;
}

/** A query plus front-door controls for its merged result list. */
export interface SearchRequest extends SearchQuery {
  /** Engine ids to search. Omitting this searches every registered engine. */
  engines?: string[];
  /** Maximum number of merged results to return. Defaults to eight. */
  limit?: number;
}

/** A single result, tagged with the engine that produced it. */
export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  /** id of the engine that produced this result. */
  source: string;
  /** Engine-reported relevance score, if any. Not comparable across engines. */
  score?: number;
  /** Anything engine-specific that doesn't fit the common fields. */
  metadata?: Record<string, unknown>;
}

/** What one engine returns for one query. */
export interface SearchResponse {
  query: SearchQuery;
  results: SearchResult[];
  /** id of the engine that produced this response. */
  engine: string;
  tookMs: number;
}

/** The ranked, client-facing response assembled from a complete engine fan-out. */
export interface MergedSearchResponse {
  /** Opaque public id shared by every result ref in this response. */
  searchId: string;
  query: SearchQuery;
  results: RankedResult[];
  tookMs: number;
  /** True when at least one selected engine failed before returning results. */
  degraded: boolean;
}

/**
 * What an engine returns when its browser work outlives its results.
 *
 * The two are deliberately separate signals: the promise from `search()`
 * resolving means *results are ready*, while `completed` settling means
 * *the session is finished*. An engine can hand back results as soon as it
 * has parsed the results page and keep using its browser page afterwards —
 * paging ahead, following links, letting storage settle — without making the
 * caller wait for any of it.
 *
 * The registry releases the search's browser lease when `completed` settles,
 * so a session that never settles leaks a page. Engines must settle it.
 */
export interface SearchSession {
  /** The results. Already resolved by the time a caller holds this. */
  response: SearchResponse;
  /** Settles when the engine is done with its browser page. */
  completed: Promise<void>;
}

/**
 * The plugin interface every backend search engine implements. Keep this
 * small and stable — it's the seam real backends (web search providers,
 * internal indexes, etc.) plug into.
 */
export interface SearchEngine {
  /** Stable, unique identifier (e.g. "bing", "internal-docs"). */
  readonly id: string;
  /** Human-readable name for display in the UI/CLI. */
  readonly name: string;
  /**
   * Underlying index family used for result aggregation. Omit this when the
   * engine is independent; ranking then uses the engine id as its family.
   */
  readonly indexFamily?: string;
  /**
   * Runs one search. Return a bare SearchResponse when the engine is done
   * the moment it has results; return a SearchSession when browser work
   * continues past them. The registry normalizes both, so engines that need
   * no browser (and no two-phase behavior) stay trivial.
   *
   * `ctx.acquireBrowser()` is lazy — an engine that never calls it never
   * causes Chromium to launch.
   */
  search(query: SearchQuery, ctx: SearchContext): Promise<SearchResponse | SearchSession>;
}

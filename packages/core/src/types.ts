/** A search request, independent of which engine(s) it's sent to. */
export interface SearchQuery {
  /** The normalized search text. */
  query: string;
  /** Maximum number of results to return per engine. Defaults to 10. */
  limit?: number;
  /** 1-based page number, for engines that support pagination. Defaults to 1. */
  page?: number;
  /** Free-form filters an engine may use to narrow results (e.g. site, lang). */
  filters?: Record<string, string>;
}

/** A query plus an optional, explicit set of engines to search. */
export interface SearchRequest extends SearchQuery {
  /** Engine ids to search. Omitting this searches every registered engine. */
  engines?: string[];
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

/**
 * The plugin interface every backend search engine implements. Keep this
 * small and stable — it's the seam real backends (web search providers,
 * internal indexes, etc.) will plug into.
 */
export interface SearchEngine {
  /** Stable, unique identifier (e.g. "mock", "bing", "internal-docs"). */
  readonly id: string;
  /** Human-readable name for display in the UI/CLI. */
  readonly name: string;
  search(query: SearchQuery): Promise<SearchResponse>;
}

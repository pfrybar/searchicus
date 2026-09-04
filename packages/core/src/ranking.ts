import { queryTokenCoverage } from "./relevance.js";
import type { EngineSearchOutcome } from "./registry.js";
import type { SearchQuery, SearchResult } from "./types.js";

/** Standard Reciprocal Rank Fusion smoothing constant. */
export const RRF_K = 60;
/** Number of merged results returned when no caller-specific limit exists yet. */
export const DEFAULT_RANKED_LIMIT = 8;
/** Keep descriptions useful without spending the caller's context on filler. */
export const MAX_SNIPPET_LENGTH = 160;

/** The engine metadata ranking needs; SearchEngine satisfies this shape. */
export interface RankingEngine {
  readonly id: string;
  /** Correlated engines share a family and contribute only one RRF vote. */
  readonly indexFamily?: string;
}

/** Options for merging already-completed per-engine search outcomes. */
export interface RankResultsOptions {
  /** Public search id used to construct result refs. */
  readonly searchId: string;
  /** Engine metadata, used to resolve each outcome's index family. */
  readonly engines: readonly RankingEngine[];
  /** Maximum number of ranked results to return. Defaults to eight. */
  readonly limit?: number;
}

/** A result selected from multiple engine responses rather than one engine. */
export type RankedResult = Omit<SearchResult, "source" | "score"> & {
  /** `<public-search-id>-<shown-rank>`, suitable for a later extract call. */
  ref: string;
  /** Family-aware Reciprocal Rank Fusion score. */
  score: number;
  /** The engine supplying the displayed title, URL, and metadata. */
  bestSource: string;
  /** Every engine that found this URL, with its 1-based result rank. */
  found: Array<{ engineId: string; rank: number }>;
  /** Unique index families contributing to this result, sorted by id. */
  families: string[];
};

interface Occurrence {
  readonly result: SearchResult;
  readonly engineId: string;
  readonly family: string;
  readonly rank: number;
  readonly canonicalUrl: string;
}

interface RankedCandidate {
  readonly canonicalUrl: string;
  readonly result: Omit<RankedResult, "ref">;
  readonly coverage: number;
  readonly bestRank: number;
}

/**
 * Normalizes a URL solely for duplicate detection.
 *
 * The returned key intentionally does not escape this module: callers see the
 * best engine's original URL, where content-defining query parameters remain
 * intact. The normalisation is deliberately narrow — only common tracking
 * parameters disappear — because a generic query parameter can change a page.
 */
export function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;

    // Search engines freely mix the two schemes for the same public page.
    url.protocol = "https:";
    if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";

    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();

    return url.toString();
  } catch {
    // Parsers normally yield absolute URLs, but an invalid URL is still safe
    // to rank as its own exact-string key rather than making ranking fail.
    return value;
  }
}

/**
 * Merges successful per-engine outcomes into one deterministic, attributed
 * ranking. Correlated engines share one reciprocal-rank contribution: within
 * a family only its best occurrence counts, while provenance retains every
 * engine that found the result.
 */
export function rankResults(
  query: SearchQuery,
  outcomes: readonly EngineSearchOutcome[],
  options: RankResultsOptions,
): RankedResult[] {
  if (!options.searchId) throw new TypeError("searchId must not be empty");

  const limit = options.limit ?? DEFAULT_RANKED_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");

  const families = new Map(options.engines.map((engine) => [engine.id, engine.indexFamily || engine.id]));
  const merged = new Map<string, Occurrence[]>();

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;

    const family = families.get(outcome.engineId) ?? outcome.engineId;
    for (const [index, result] of outcome.response.results.entries()) {
      const canonicalUrl = canonicalizeUrl(result.url);
      const occurrences = merged.get(canonicalUrl) ?? [];
      occurrences.push({ result, engineId: outcome.engineId, family, rank: index + 1, canonicalUrl });
      merged.set(canonicalUrl, occurrences);
    }
  }

  const candidates = [...merged.values()].map((occurrences) => rankOccurrences(query, occurrences));
  candidates.sort(compareCandidates);

  const perHost = new Map<string, number>();
  const selected: RankedCandidate[] = [];
  for (const candidate of candidates) {
    const host = hostFor(candidate.canonicalUrl);
    const count = perHost.get(host) ?? 0;
    if (count >= 2) continue;

    perHost.set(host, count + 1);
    selected.push(candidate);
    if (selected.length === limit) break;
  }

  return selected.map(({ result }, index) => ({ ...result, ref: `${options.searchId}-${index + 1}` }));
}

function rankOccurrences(query: SearchQuery, occurrences: Occurrence[]): RankedCandidate {
  const sorted = [...occurrences].sort(compareOccurrences);
  const best = sorted[0];
  if (!best) throw new Error("Cannot rank an empty occurrence set");

  const bestByEngine = new Map<string, Occurrence>();
  const bestByFamily = new Map<string, Occurrence>();
  for (const occurrence of sorted) {
    if (!bestByEngine.has(occurrence.engineId)) bestByEngine.set(occurrence.engineId, occurrence);
    if (!bestByFamily.has(occurrence.family)) bestByFamily.set(occurrence.family, occurrence);
  }

  const score = [...bestByFamily.values()].reduce((total, occurrence) => total + 1 / (RRF_K + occurrence.rank), 0);
  const snippet = sorted.find((occurrence) => occurrence.result.snippet)?.result.snippet;
  const result: Omit<RankedResult, "ref"> = {
    title: best.result.title,
    url: best.result.url,
    ...(snippet ? { snippet: truncateSnippet(snippet) } : {}),
    ...(best.result.metadata ? { metadata: best.result.metadata } : {}),
    score,
    bestSource: best.engineId,
    found: [...bestByEngine.values()].sort(compareOccurrences).map(({ engineId, rank }) => ({ engineId, rank })),
    families: [...bestByFamily.keys()].sort(),
  };

  return {
    canonicalUrl: best.canonicalUrl,
    coverage: queryTokenCoverage(query.query, [{ ...best.result, snippet }]),
    bestRank: best.rank,
    result,
  };
}

function compareOccurrences(left: Occurrence, right: Occurrence): number {
  return (
    left.rank - right.rank ||
    left.engineId.localeCompare(right.engineId) ||
    left.result.url.localeCompare(right.result.url) ||
    left.result.title.localeCompare(right.result.title)
  );
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return (
    right.result.score - left.result.score ||
    right.coverage - left.coverage ||
    left.bestRank - right.bestRank ||
    left.canonicalUrl.localeCompare(right.canonicalUrl)
  );
}

function hostFor(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname;
  } catch {
    return canonicalUrl;
  }
}

function truncateSnippet(snippet: string): string {
  if (snippet.length <= MAX_SNIPPET_LENGTH) return snippet;

  const boundary = snippet.lastIndexOf(" ", MAX_SNIPPET_LENGTH);
  const end = boundary > MAX_SNIPPET_LENGTH / 2 ? boundary : MAX_SNIPPET_LENGTH;
  return `${snippet.slice(0, end).trimEnd()}…`;
}

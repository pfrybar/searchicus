import type { SearchResult } from "./types.js";

/**
 * Guards against a results page that parses perfectly and means nothing.
 *
 * The failure this exists for is not a block. A search engine can answer a
 * multi-word query with results for only its *first* term — "best waterpark
 * in chicago" comes back full of "Best Buy", which is what Bing did and what
 * named this module. HTTP 200, valid markup, the parser is happy, and every
 * result is real; they are simply answers to a question nobody asked. It is
 * the worst shape of failure because nothing looks wrong, so it has to be
 * detected from the content rather than the transport. (Not unique to
 * automation — searx/searxng#4964 reports the same "results matching only 1
 * word or 2 words" behaviour — but it shows up more on traffic a search
 * engine is suspicious of.)
 *
 * Every engine runs this gate, and it is deliberately engine-agnostic: it
 * scores a result set against the query it claims to answer, with no
 * knowledge of who produced it.
 *
 * The signal is token coverage: how much of what was asked for appears
 * anywhere in what came back. A first-term-only page scores about 1/n and is
 * unmistakable; a genuinely good page scores near 1.
 *
 * These numbers are ours and are not tuned against a corpus. They are set to
 * catch a dramatic failure, not to grade result quality — an aggressive
 * threshold here would throw away good searches to catch a rare bad one.
 */

/**
 * Minimum fraction of a query's content tokens that must appear somewhere in
 * the results before they are believed.
 *
 * 0.6 is chosen against the shape of the failure rather than a corpus. The
 * mangled page matches one token out of n, so it scores 0.5 for a two-token
 * query and 0.33 for a three-token one; both are caught. A good page missing
 * a single token out of three scores 0.67 and survives.
 */
export const RELEVANCE_THRESHOLD = 0.6;

/** Shortest token worth scoring. Below this, tokens match too much of anything. */
const MIN_TOKEN_LENGTH = 2;

/**
 * Function words carry no topic, so they would inflate coverage: a page of
 * "Best Buy" results "covers" the `in` of "best waterpark in chicago".
 * Deliberately short — this is not a stemming pipeline, and dropping a word
 * that turns out to matter is worse than keeping one that doesn't.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export interface RelevanceReport {
  /** Fraction of query content tokens found anywhere in the results (0-1). */
  coverage: number;
  /** Mean fraction of query content tokens present in each single result (0-1). */
  match: number;
  /** True when coverage falls below the threshold. */
  offTarget: boolean;
  /** The content tokens that appear in no result at all. */
  missing: string[];
}

/**
 * Word boundaries from ICU, not from a character class.
 *
 * The locale is pinned rather than left to the environment, so the same text
 * tokenizes the same way wherever this runs — an archive shared between
 * processes should not depend on anyone's LANG. Pinning costs nothing for the
 * scripts that need the help: ICU breaks Chinese and Japanese with a
 * dictionary rather than by locale, and "ja" was measured to give the same
 * answer here.
 */
const WORD_SEGMENTER = new Intl.Segmenter("en", { granularity: "word" });

/**
 * Lowercases, folds accents, and splits into tokens.
 *
 * The split was `/[^a-z0-9]+/`, which treats every non-ASCII character as a
 * separator. A Cyrillic, Greek, Arabic or CJK query therefore produced no
 * tokens at all — and `queryTokenCoverage` reads no tokens as "nothing to
 * check" and returns 1, so for those queries the off-target gate was not
 * lenient, it was absent. No regex fixes this: Japanese is written without
 * spaces between words, so finding them needs a dictionary, which is what
 * ICU has and a character class never will.
 *
 * Accent folding happens *before* segmentation so "Café" and "Cafe" stay one
 * token, and the range is the Latin combining block specifically — stripping
 * marks wholesale would destroy scripts where they carry meaning rather than
 * decorate a letter.
 */
export function tokenize(text: string): string[] {
  const folded = text
    .normalize("NFKD")
    // Combining marks, but only where they decorate a Latin letter, so
    // "Café" and "Cafe" are one token. Stripping them everywhere folded
    // Cyrillic "й" into "и", which is a different letter rather than an
    // accented one — the equivalent of deciding "i" and "l" are the same.
    .replace(/([A-Za-z])[\u0300-\u036f]+/g, "$1")
    // Back to composed form. Decomposition is a step in folding, not a
    // property tokens should carry: "й" left as "и" plus a combining breve
    // looks identical and compares unequal, which is a trap for anything
    // that later uses a token as a key.
    .normalize("NFC")
    .toLowerCase();

  const tokens: string[] = [];
  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(folded)) {
    if (isWordLike) tokens.push(segment);
  }
  return tokens;
}

/** The tokens of a query that actually carry its topic. */
export function contentTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token)) seen.add(token);
  }
  return [...seen];
}

/**
 * True when `token` appears among `haystack`, allowing either to be a prefix
 * of the other so plurals and simple inflections still count
 * ("waterpark"/"waterparks", "review"/"reviews"). Prefix matching is capped
 * at four characters, below which prefixes are too promiscuous to mean
 * anything.
 */
function tokenPresent(token: string, haystack: Set<string>): boolean {
  if (haystack.has(token)) return true;
  if (token.length < 4) return false;

  for (const candidate of haystack) {
    if (candidate.length < 4) continue;
    if (candidate.startsWith(token) || token.startsWith(candidate)) return true;
  }

  return false;
}

/** Every token a single result offers: its title, snippet, and URL. */
function resultTokens(result: SearchResult): Set<string> {
  return new Set(tokenize(`${result.title} ${result.snippet ?? ""} ${result.url}`));
}

/**
 * Fraction of the query's content tokens that appear in at least one result.
 *
 * This is the measure that catches the first-term-only page: it answers
 * "how much of what I asked about is present at all", which collapses when
 * the engine silently drops every term but one.
 */
export function queryTokenCoverage(query: string, results: SearchResult[]): number {
  const tokens = contentTokens(query);
  // Nothing to be off-target about: a query of pure stopwords, or no query.
  if (tokens.length === 0) return 1;
  if (results.length === 0) return 0;

  const found = new Set<string>();
  for (const result of results) {
    const haystack = resultTokens(result);
    for (const token of tokens) {
      if (tokenPresent(token, haystack)) found.add(token);
    }
  }

  return found.size / tokens.length;
}

/**
 * Mean fraction of query tokens present in each individual result.
 *
 * Complements coverage rather than duplicating it: a page can cover every
 * token across ten results while no single result is about the query.
 * Reported for observability; the gate deliberately runs on coverage alone,
 * because a low match is normal for broad queries and would cause false
 * alarms.
 */
export function relevanceMatch(query: string, results: SearchResult[]): number {
  const tokens = contentTokens(query);
  if (tokens.length === 0) return 1;
  if (results.length === 0) return 0;

  let total = 0;
  for (const result of results) {
    const haystack = resultTokens(result);
    total += tokens.filter((token) => tokenPresent(token, haystack)).length / tokens.length;
  }

  return total / results.length;
}

/** Scores a result set against its query. See RelevanceReport. */
export function assessRelevance(
  query: string,
  results: SearchResult[],
  threshold = RELEVANCE_THRESHOLD,
): RelevanceReport {
  const tokens = contentTokens(query);
  const coverage = queryTokenCoverage(query, results);
  const found = new Set<string>();

  for (const result of results) {
    const haystack = resultTokens(result);
    for (const token of tokens) {
      if (tokenPresent(token, haystack)) found.add(token);
    }
  }

  return {
    coverage,
    match: relevanceMatch(query, results),
    offTarget: coverage < threshold,
    missing: tokens.filter((token) => !found.has(token)),
  };
}

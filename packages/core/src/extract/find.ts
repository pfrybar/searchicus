/**
 * Ranked section selection: the few parts of a page that answer a query.
 *
 * The chunker is the one in sections.ts rather than a second slicer, so a
 * match is addressed by the same `offset` that `extract` and `outline`
 * already take. What is added here is the scoring, and it is deliberately
 * not the scorer relevance.ts uses for search results: coverage is an
 * absolute, thresholdable gate, and BM25 is an ordering whose scores are not
 * comparable between queries. Two jobs, two scorers. ICU token boundaries are
 * shared, while find normalizes its ASCII-Latin words with Porter stemming.
 * Every scoring and coverage read uses that same normalization, so a section
 * cannot rank first while reporting `coverage: 0`.
 */
import { stemmer } from "stemmer";
import { tokenize } from "../relevance.js";
import {
  balanceFences,
  displayHeading,
  isNavigable,
  safeCut,
  splitBlocks,
  splitSections,
  type Block,
  type Section,
} from "./sections.js";

/**
 * How much a query term in a heading counts for, against one in the body.
 *
 * Headings are the strongest feature a page offers: an author writing
 * "2.1. Checkpointing" has labelled that section better than any scorer
 * could. The nearest heading outweighs its ancestors because it is the
 * specific one — a page title appears in every path and would otherwise
 * drown the distinction it is supposed to help make.
 *
 * Folded into the term frequency *before* saturation, BM25F-style, rather
 * than multiplied into the finished score. Multiplying afterwards would
 * treble a number that saturation had already capped, which overstates a
 * heading hit in exactly the sections that least need the help.
 */
export const HEADING_WEIGHT_NEAREST = 3;
export const HEADING_WEIGHT_ANCESTOR = 1;

/** Standard BM25 term saturation and length normalisation constants. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** A compact ordered query phrase makes a section more likely to answer it. */
export const PHRASE_BOOST = 0.2;

/** All query terms appearing near one another is useful even out of order. */
export const PROXIMITY_BOOST = 0.15;

/** Terms farther apart than this receive no proximity credit. */
export const PROXIMITY_WINDOW = 24;

/**
 * Length below which a section gets no brevity bonus.
 *
 * Length normalisation reads a very short section as extremely dense, so a
 * two-line note mentioning a query term once outranks the chapter that
 * explains it. The floor caps that.
 *
 * It is not what handles a heading-only section — that needed excluding
 * outright, see the filter in findSections. Measured while writing the
 * tests: with only this floor, "# Checkpoint starvation" followed
 * immediately by another heading still beat the prose beneath it.
 */
export const LENGTH_FLOOR = 200;

/** A term is rare when it appears in at most this fraction of candidates. */
export const RARE_TERM_SECTION_FRACTION = 0.25;

/**
 * Minimum in-page-IDF-weighted coverage for a candidate to be returned.
 *
 * Unlike a flat fraction of query words, this lets a section containing the
 * page's distinctive answer survive a longer natural-language question. When
 * the page has rare query terms, a candidate must contain at least one of
 * them, so a generic section cannot pass merely by repeating common words.
 */
export const WEIGHTED_COVERAGE_FLOOR = 0.3;

/** Budget below which a further match would be an unreadable fragment. */
export const MIN_MATCH_CHARS = 200;

/** One selected section, with where it sits in the document it came from. */
export interface FindMatch {
  /** Readable enclosing headings, outermost first. Empty above the first heading. */
  readonly path: string[];
  /** Pass to `extract` as `offset` to read this section in place. */
  readonly offset: number;
  /** Fraction of the query's content words this section carries, 0–1. */
  readonly coverage: number;
  readonly markdown: string;
  readonly chars: number;
  /**
   * The section's full text length, so `chars < sectionChars` is exactly
   * `truncated`. Measures the text rather than the document span the outline
   * reports, which is a character longer: the newline before the next
   * heading separates sections and belongs to neither.
   */
  readonly sectionChars: number;
  readonly truncated: boolean;
}

/** A section's own heading line, which opens its text. */
const LEADING_HEADING = /^ {0,3}#{1,6}\s+[^\n]*\n?/;

interface ScoredSection {
  readonly section: Section;
  readonly score: number;
  readonly coverage: number;
  readonly passesGate: boolean;
  /** Whether anything but the heading is here. See the filter below. */
  readonly hasBody: boolean;
}

interface TermStatistics {
  readonly idf: number[];
  readonly rareTerms: number[];
  readonly availableWeight: number;
}

/**
 * The best sections of a document for a query, best first, within a budget.
 *
 * Returns no matches for a query with no content words and for a document
 * where nothing clears the answer gate. Both are answers rather than
 * errors: the caller asked a question, and "this page does not discuss that"
 * is a true one.
 *
 * `navigable` is the same predicate `outline` reports, and it is what
 * separates that true answer from a useless one. A page with no real
 * structure has one enormous section, so there is nothing for section
 * matching to grip: an empty result there means "this page could not be
 * searched this way", not "this page lacks the information". Found by
 * evaluation — agents could not tell the two apart and stopped looking.
 */
export function findSections(
  markdown: string,
  query: string,
  maxChars: number,
): { matches: FindMatch[]; navigable: boolean } {
  const terms = findContentTokens(query);
  const sections = splitSections(markdown);
  const navigable = isNavigable(
    sections.map((section) => section.end - section.start),
    markdown.length,
  );
  if (terms.length === 0 || sections.length === 0) return { matches: [], navigable };

  const tokens = sections.map(sectionTokens);
  const lengths = sections.map((section) => Math.max(section.end - section.start, LENGTH_FLOOR));
  const averageLength = lengths.reduce((total, length) => total + length, 0) / lengths.length;

  // Every section's term frequencies first: the IDF of a term needs its
  // document frequency across the whole page before any section can be
  // scored against it.
  const frequencies = tokens.map((sectionTokens) =>
    terms.map(
      (term) =>
        countTermMatches(term, sectionTokens.body) +
        HEADING_WEIGHT_NEAREST * countTermMatches(term, sectionTokens.nearest) +
        HEADING_WEIGHT_ANCESTOR * countTermMatches(term, sectionTokens.ancestors),
    ),
  );

  const statistics = termStatistics(frequencies, terms.length);

  const scored = sections.map((section, index): ScoredSection => {
    const row = frequencies[index] ?? [];
    const normalization = BM25_K1 * (1 - BM25_B + (BM25_B * (lengths[index] ?? LENGTH_FLOOR)) / averageLength);

    let score = 0;
    let present = 0;
    for (let term = 0; term < terms.length; term++) {
      const frequency = row[term] ?? 0;
      if (frequency <= 0) continue;
      present++;
      score += (statistics.idf[term] ?? 0) * (frequency / (frequency + normalization));
    }
    // BM25 sees a bag of words. A phrase or a tight cluster contains more
    // evidence of an answer than the same words scattered through a section.
    score += sequenceBoost(terms, tokens[index]?.body ?? []);

    return {
      section,
      score,
      coverage: present / terms.length,
      passesGate: passesTermGate(row, statistics),
      hasBody: (tokens[index]?.body.length ?? 0) > 0,
    };
  });

  const ranked = scored
    // A section holding nothing but its own heading has no content to
    // return, and the length floor alone does not stop it winning: a
    // three-word heading that is entirely query terms is the densest thing
    // on the page. Its descriptive power is not lost — it weighs on every
    // section beneath it as an ancestor, which is where it belongs.
    .filter((entry) => entry.hasBody && entry.passesGate)
    // Offset breaks a tie, so the same page and query always select the same
    // sections in the same order.
    .sort((a, b) => b.score - a.score || a.section.start - b.section.start);

  return { matches: select(markdown, ranked, terms, maxChars), navigable };
}

/**
 * Splits a section's tokens into the three fields that score differently.
 *
 * A section's text opens with its own heading line, so counting that as body
 * would count the nearest heading twice — once weighted and once not. The
 * ancestors are not in the text at all and would otherwise never be counted.
 */
function sectionTokens(section: Section): { body: string[]; nearest: string[]; ancestors: string[] } {
  return {
    body: findTokens(section.text.replace(LEADING_HEADING, "")),
    nearest: findTokens(section.headings.at(-1) ?? ""),
    ancestors: findTokens(section.headings.slice(0, -1).join(" ")),
  };
}

/**
 * Fills the budget in score order, whole sections first.
 *
 * Whole sections are the point: an excerpt cropped around a keyword loses the
 * sentence that set it up and the one that qualifies it, while a section is a
 * unit the author chose to be self-contained. Measured across five real
 * reference pages, one section in 134 exceeds a 6,000-character budget, so
 * this is the ordinary path.
 *
 * When a section will not fit, the answer is not its opening. A section is
 * chosen *because* the query terms are in it, so cutting from the start
 * returns a window picked without any reference to where they are: asking
 * sqlite.org/pragma.html for `busy_timeout` scores a 93,820-character
 * section on a term 90,000 characters in, and its first 2,570 characters are
 * about `analysis_limit`. So an oversized section is split at its blank lines
 * and the same scoring runs over those blocks — cut to the match rather than
 * to the beginning.
 */
function select(markdown: string, ranked: ScoredSection[], terms: string[], maxChars: number): FindMatch[] {
  const matches: FindMatch[] = [];
  let remaining = maxChars;

  const take = (section: Section, start: number, end: number): void => {
    const text = markdown.slice(start, end).trimEnd();
    if (text.trim().length === 0) return;
    matches.push({
      path: section.headings.map(displayHeading),
      offset: start,
      // Measured on what came back rather than on the section it came from.
      // Coverage is the number a caller acts on, and a promise about text
      // that was not delivered is worse than no promise at all.
      coverage: Math.round(coverageOf(text, terms) * 100) / 100,
      markdown: text,
      chars: text.length,
      sectionChars: section.text.trimEnd().length,
      // From positions, not lengths. A whole section trims to a character
      // shorter than its own span — the newline before the next heading —
      // and comparing lengths reported every complete section as truncated.
      truncated: start > section.start || end < section.end,
    });
    remaining -= text.length;
  };

  for (const { section } of ranked) {
    // A sliver of budget buys an unreadable fragment.
    if (remaining < MIN_MATCH_CHARS) break;

    if (section.text.length <= remaining) {
      take(section, section.start, section.end);
      continue;
    }

    const runs = selectWithin(markdown, section, terms, remaining);
    if (runs.length > 0) {
      for (const run of runs) take(section, run.start, run.end);
      continue;
    }

    // Nothing to sub-split — a section with one block, or none scoring.
    const text = safeSlice(markdown, section.start, remaining);
    if (text.length >= MIN_MATCH_CHARS) take(section, section.start, section.start + text.length);
  }

  // Skipping every candidate would say "no section covered this query" about
  // a page where several did — the budget was simply smaller than any of
  // them. That is the one thing an empty result must never mean, since the
  // whole contract is that empty is an answer. Take the best one cut hard.
  if (matches.length === 0 && ranked[0]) {
    const { section } = ranked[0];
    remaining = maxChars;
    const text = hardCut(markdown.slice(section.start, section.start + maxChars));
    if (text.trim().length > 0) take(section, section.start, section.start + text.length);
  }

  return matches;
}

/**
 * The best blocks of one oversized section, merged where they are adjacent.
 *
 * Scored the same way the sections were, over the blocks of this one section:
 * document frequency across a section's own blocks measures how distinctive a
 * term is *within it*, which is the same argument one level down.
 *
 * Merging is a presentation step and not a selection one — blocks are chosen
 * on score alone, and any that turn out to be neighbours are then emitted as
 * one excerpt. It therefore costs no budget, and it stops two halves of one
 * passage arriving as two unrelated quotations.
 *
 * Returns nothing when the section has a single block or none of them score,
 * leaving the caller to fall back.
 */
function selectWithin(
  markdown: string,
  section: Section,
  terms: string[],
  budget: number,
): { start: number; end: number }[] {
  const blocks = splitBlocks(markdown, section.start, section.end);
  if (blocks.length < 2) return [];

  const tokens = blocks.map((block) => findTokens(block.text));
  // The section's own heading applies to every block equally, so it cannot
  // separate them and is left out.
  const frequencies = tokens.map((blockTokens) => terms.map((term) => countTermMatches(term, blockTokens)));
  const lengths = blocks.map((block) => Math.max(block.end - block.start, LENGTH_FLOOR));
  const averageLength = lengths.reduce((total, length) => total + length, 0) / lengths.length;

  const statistics = termStatistics(frequencies, terms.length);

  const scored = blocks.map((block, index) => {
    const row = frequencies[index] ?? [];
    const normalization = BM25_K1 * (1 - BM25_B + (BM25_B * (lengths[index] ?? LENGTH_FLOOR)) / averageLength);
    let score = 0;
    for (let term = 0; term < terms.length; term++) {
      const frequency = row[term] ?? 0;
      if (frequency > 0) score += (statistics.idf[term] ?? 0) * (frequency / (frequency + normalization));
    }
    score += sequenceBoost(terms, tokens[index] ?? []);
    return { block, score, passesGate: passesTermGate(row, statistics) };
  });

  const ranked = [...scored]
    // A block holding none of the query's words is padding, not an answer.
    // Filling leftover budget with it would spend a caller's context on text
    // chosen for fitting rather than for matching.
    .filter((entry) => entry.score > 0 && entry.passesGate)
    .sort((a, b) => b.score - a.score || a.block.start - b.block.start);
  if (ranked.length === 0) return [];

  // The anchor is the best-scoring block that can actually be returned. It
  // is always represented, because packing lesser blocks around a top block
  // that did not fit is how this went wrong before: the answer was skipped
  // for being large and a sixteen-character heading was returned because it
  // fitted. Cutting the best block beats returning the whole of a worse one.
  //
  // A block is skipped only when it cannot be returned at all — a fenced
  // listing longer than the budget, which balances back to nothing.
  let anchor = -1;
  let cut = "";
  for (const [index, { block }] of ranked.entries()) {
    if (block.end - block.start <= budget) {
      anchor = index;
      break;
    }
    const text = safeSlice(markdown, block.start, budget);
    if (text.length >= MIN_MATCH_CHARS) {
      anchor = index;
      cut = text;
      break;
    }
  }
  if (anchor < 0) return [];

  const first = ranked[anchor]?.block;
  if (!first) return [];
  if (cut) return [{ start: first.start, end: first.start + cut.length }];

  const chosen: Block[] = [first];
  let remaining = budget - (first.end - first.start);
  for (const [index, { block }] of ranked.entries()) {
    if (index === anchor) continue;
    if (remaining < MIN_MATCH_CHARS) break;
    const length = block.end - block.start;
    if (length <= remaining) {
      chosen.push(block);
      remaining -= length;
    }
  }

  chosen.sort((a, b) => a.start - b.start);
  const runs: { start: number; end: number }[] = [];
  for (const block of chosen) {
    const last = runs.at(-1);
    // Blocks tile the section, so neighbours meet exactly.
    if (last && block.start <= last.end) last.end = block.end;
    else runs.push({ start: block.start, end: block.end });
  }
  return runs;
}

/**
 * Per-candidate term statistics for both BM25 ordering and the answer gate.
 *
 * Document frequency is scoped to this page's sections (or to one oversized
 * section's blocks), which makes it a measure of what is distinctive in the
 * document the caller is reading. Terms absent from every candidate are not
 * gate requirements: no candidate can supply them, and they must not erase a
 * useful answer to the terms this page actually discusses.
 */
function termStatistics(frequencies: readonly (readonly number[])[], termCount: number): TermStatistics {
  const candidateCount = frequencies.length;
  const documentFrequencies = Array.from({ length: termCount }, (_, index) =>
    frequencies.reduce((count, row) => count + ((row[index] ?? 0) > 0 ? 1 : 0), 0),
  );
  const rareLimit = Math.max(1, Math.floor(candidateCount * RARE_TERM_SECTION_FRACTION));
  const idf = documentFrequencies.map((df) => {
    // The `1 +` keeps common terms from becoming a negative BM25 penalty.
    return Math.log(1 + (candidateCount - df + 0.5) / (df + 0.5));
  });
  const rareTerms = documentFrequencies.flatMap((df, index) => (df > 0 && df <= rareLimit ? [index] : []));
  const availableWeight = idf.reduce((total, weight, index) => total + (documentFrequencies[index] ? weight : 0), 0);

  return { idf, rareTerms, availableWeight };
}

/**
 * True when a candidate contains a distinctive term, when one exists, and
 * enough available IDF weight to be an answer rather than a generic mention.
 * A multi-part question can have several rare terms in different sections;
 * requiring every one from each section would turn that useful survey into an
 * all-or-nothing test again.
 */
function passesTermGate(frequencies: readonly number[], statistics: TermStatistics): boolean {
  if (statistics.availableWeight === 0) return false;
  if (statistics.rareTerms.length > 0 && statistics.rareTerms.every((index) => (frequencies[index] ?? 0) === 0)) {
    return false;
  }

  const matchedWeight = statistics.idf.reduce(
    (total, weight, index) => total + ((frequencies[index] ?? 0) > 0 ? weight : 0),
    0,
  );
  return matchedWeight / statistics.availableWeight >= WEIGHTED_COVERAGE_FLOOR;
}

/** Fraction of the query's content words present in a piece of text. */
function coverageOf(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const tokens = findTokens(text);
  return terms.filter((term) => countTermMatches(term, tokens) > 0).length / terms.length;
}

/**
 * Question scaffolding that should not become a required section term.
 *
 * This is intentionally not relevance.ts's list. Search relevance asks
 * whether remote result titles and snippets broadly address a query, so it
 * keeps its list small rather than risk overlooking a topic word. Find has a
 * different job: choose passages from one page. In "How can I configure my
 * busy_timeout?", `how`, `can`, and `my` should not make an otherwise exact
 * busy_timeout section miss coverage; `configure` remains the subject term.
 *
 * English-only filtering is deliberate. ICU still tokenizes every script,
 * but guessing stopwords in languages we have not evaluated would silently
 * delete subject words. Technical names are kept by the ASCII-word test too;
 * their more complete classification is owned by the identifier work.
 */
const FIND_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "here",
  "how",
  "i",
  "in",
  "is",
  "it",
  "keep",
  "may",
  "me",
  "might",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "tell",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "without",
  "would",
  "you",
  "your",
]);

/**
 * Query words with find's own question-aware normalization.
 *
 * Porter is useful for English prose (query/queries, run/running) but is not
 * a general Unicode stemmer. Keep any token containing non-ASCII letters,
 * digits, or identifier punctuation exact; ICU still supplies its boundaries
 * for every script, and technical names such as `busy_timeout` cannot turn
 * into broad prefix matches. Stopwords are removed before stemming so an
 * inflected stopword can never become a spurious required term.
 */
export function findContentTokens(query: string): string[] {
  const terms = new Set<string>();
  for (const token of classifyFindTokens(query)) {
    if (token.kind === "identifier") {
      terms.add(token.value);
      continue;
    }
    if (token.value.length < 2 || FIND_STOPWORDS.has(token.value)) continue;
    terms.add(stemFindToken(token.value));
  }
  return [...terms];
}

/** Applies the same scoped normalization to document terms and query terms. */
function findTokens(text: string): string[] {
  return classifyFindTokens(text).map((token) =>
    token.kind === "identifier" ? token.value : stemFindToken(token.value),
  );
}

type FindTokenKind = "prose" | "identifier";

interface ClassifiedFindToken {
  readonly kind: FindTokenKind;
  /** Prose is lowercased by ICU; identifiers retain their exact spelling. */
  readonly value: string;
}

/**
 * Code-like names need different matching semantics from prose.
 *
 * ICU word segmentation remains the right tool for natural language, but it
 * splits `node:sqlite` into two ordinary words and lowercases `fooBar` into
 * `foobar`. Both transformations are useful for prose and wrong for a name a
 * caller expects to match literally. Pull recognized technical forms out
 * first, then give only the text around them to ICU.
 *
 * This deliberately recognizes a bounded, ASCII-led vocabulary rather than
 * calling every punctuation-bearing string an identifier. It covers flags,
 * scoped packages, URL/path-like forms, dotted/colon-separated names,
 * camelCase, C#, .NET, and conventional versions. New forms belong here with
 * tests; permissive prefix matching is not a fallback for unclassified text.
 */
const TECHNICAL_IDENTIFIER =
  /https?:\/\/[^\s<>()[\]{}"'`]+|\.{0,2}\/[A-Za-z0-9._~%+@=-]+(?:\/[A-Za-z0-9._~%+@=-]+)*|@[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+|--[A-Za-z0-9][A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9]*(?:[_:./][A-Za-z0-9][A-Za-z0-9_.:/-]*)+|[A-Za-z]+[a-z][A-Z][A-Za-z0-9]*|[A-Za-z]#|\.NET|v\d+(?:\.\d+)+/g;

function classifyFindTokens(text: string): ClassifiedFindToken[] {
  const unescaped = unescapeMarkdown(text);
  const tokens: ClassifiedFindToken[] = [];
  let cursor = 0;

  for (const match of unescaped.matchAll(TECHNICAL_IDENTIFIER)) {
    const index = match.index;
    if (index === undefined) continue;
    addProseTokens(tokens, unescaped.slice(cursor, index));
    const identifier = trimIdentifierPunctuation(match[0] ?? "");
    if (identifier) tokens.push({ kind: "identifier", value: identifier.normalize("NFC") });
    cursor = index + (match[0]?.length ?? 0);
  }
  addProseTokens(tokens, unescaped.slice(cursor));
  return tokens;
}

function addProseTokens(tokens: ClassifiedFindToken[], text: string): void {
  for (const value of tokenize(text)) tokens.push({ kind: "prose", value });
}

/** Sentence punctuation may follow an identifier but is not part of its name. */
function trimIdentifierPunctuation(identifier: string): string {
  return identifier.replace(/[),.;!?]+$/, "");
}

/**
 * A backslash escape, as CommonMark defines it: any ASCII punctuation
 * character. Deliberately not "any backslash" — `\d` inside a code block is a
 * regex, not an escaped letter, and stripping that would corrupt snippets.
 */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/**
 * Undoes Markdown's escaping before tokenizing.
 *
 * A rendered page writes `busy\_timeout`, because a bare underscore would be
 * emphasis. ICU then splits at the backslash into "busy" and "_timeout",
 * while the caller's `busy_timeout` stays one token — so exact comparison
 * fails and a page documenting the pragma in full returns nothing. The old
 * bidirectional prefix rule hid this by matching "busy", which is to say it
 * got the right answer for a reason that was never sound.
 *
 * Applied to both sides, because the invariant that matters is that the query
 * and the document are compared as the same characters.
 *
 * Tokenization only. The Markdown handed back to a caller is untouched, so
 * escapes still render as their authors intended.
 */
function unescapeMarkdown(text: string): string {
  return text.includes("\\") ? text.replace(MARKDOWN_ESCAPE, "$1") : text;
}

/** Stem ordinary ASCII-Latin prose only; everything else remains exact. */
function stemFindToken(token: string): string {
  return /^[a-z]+$/.test(token) ? stemmer(token) : token;
}

/** Exact after shared normalization: no bidirectional prefix relation. */
function countTermMatches(term: string, tokens: readonly string[]): number {
  let count = 0;
  for (const token of tokens) if (token === term) count++;
  return count;
}

/**
 * The ordered and near-together evidence BM25 deliberately does not model.
 *
 * The phrase part rewards each adjacent pair from the normalized query that
 * occurs in the same order in the text. It therefore still helps a longer
 * question whose complete wording does not occur verbatim. The proximity part
 * looks for the smallest token window covering every query term, regardless
 * of order; it rewards a compact explanation without pretending that word
 * order did not matter. Both are capped additive bonuses, so a phrase does
 * not replace term frequency, IDF, heading evidence, or the coverage gate.
 */
function sequenceBoost(terms: readonly string[], tokens: readonly string[]): number {
  if (terms.length < 2 || tokens.length < 2) return 0;

  const orderedPairs = new Set<string>();
  for (let index = 0; index < terms.length - 1; index++) {
    orderedPairs.add(`${terms[index]}\u0000${terms[index + 1]}`);
  }
  const matchedPairs = new Set<string>();
  for (let index = 0; index < tokens.length - 1; index++) {
    const pair = `${tokens[index]}\u0000${tokens[index + 1]}`;
    if (orderedPairs.has(pair)) matchedPairs.add(pair);
  }

  return (PHRASE_BOOST * matchedPairs.size) / (terms.length - 1) + proximityBonus(terms, tokens);
}

/** The tightest text span that contains every distinct query term. */
function proximityBonus(terms: readonly string[], tokens: readonly string[]): number {
  // A complete window cannot be shorter than the number of distinct terms.
  // At the configured width the interpolation denominator would be zero, so
  // leave those exceptionally long queries to their BM25 and phrase signals.
  if (terms.length >= PROXIMITY_WINDOW) return 0;

  const wanted = new Set(terms);
  const counts = new Map<string, number>();
  let distinct = 0;
  let left = 0;
  let smallest = Number.POSITIVE_INFINITY;

  for (let right = 0; right < tokens.length; right++) {
    const rightTerm = tokens[right];
    if (rightTerm && wanted.has(rightTerm)) {
      const count = counts.get(rightTerm) ?? 0;
      counts.set(rightTerm, count + 1);
      if (count === 0) distinct++;
    }

    while (distinct === terms.length) {
      smallest = Math.min(smallest, right - left + 1);
      const leftTerm = tokens[left];
      if (leftTerm && wanted.has(leftTerm)) {
        const count = counts.get(leftTerm) ?? 0;
        if (count === 1) distinct--;
        counts.set(leftTerm, count - 1);
      }
      left++;
    }
  }

  if (smallest > PROXIMITY_WINDOW) return 0;
  return (PROXIMITY_BOOST * (PROXIMITY_WINDOW - smallest)) / (PROXIMITY_WINDOW - terms.length);
}

/**
 * A section cut to a budget, preferring a boundary that keeps code intact.
 *
 * Falls back to a hard cut when the safe boundary would leave a stub.
 * safeCut takes a line boundary outside a fence "even when it wastes most of
 * the budget", which is right for a window that resumes at nextOffset and
 * wrong here, where nothing resumes. Measured against sqlite.org/wal.html at
 * a 1,500-character budget, that rule returned 41 and 43 characters — the
 * heading line and nothing else.
 */
function safeSlice(markdown: string, start: number, budget: number): string {
  const safe = markdown.slice(start, safeCut(markdown, start, start, budget)).trimEnd();
  if (safe.length >= MIN_MATCH_CHARS) return balanceFences(safe);
  return balanceFences(hardCut(markdown.slice(start, start + budget)));
}

/** Trims a slice back to a word boundary, so it ends mid-sentence not mid-word. */
function hardCut(slice: string): string {
  const space = slice.lastIndexOf(" ");
  return (space > slice.length / 2 ? slice.slice(0, space) : slice).trimEnd();
}

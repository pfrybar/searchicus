/**
 * Ranked section selection: the few parts of a page that answer a query.
 *
 * The chunker is the one in sections.ts rather than a second slicer, so a
 * match is addressed by the same `offset` that `extract` and `outline`
 * already take. What is added here is the scoring, and it is deliberately
 * not the scorer relevance.ts uses for search results: coverage is an
 * absolute, thresholdable gate, and BM25 is an ordering whose scores are not
 * comparable between queries. Two jobs, two scorers. The tokenizer is shared,
 * because a section that ranks first while reporting `coverage: 0` would be
 * incoherent.
 */
import { contentTokens, countTokenMatches, tokenize } from "../relevance.js";
import { isNavigable, safeCut, splitSections, type Section } from "./sections.js";

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

/**
 * Fraction of the query's content words a section must carry to be returned.
 *
 * The gate, not the ranking. Returning the best three sections of a page
 * that discusses none of what was asked is the off-target search failure one
 * layer down: a confident answer to a question the document cannot answer.
 * Below this the honest response is no matches at all, which leaves the
 * caller to `outline` or `extract` instead.
 */
export const COVERAGE_FLOOR = 0.5;

/** Budget below which a further match would be an unreadable fragment. */
export const MIN_MATCH_CHARS = 200;

/** One selected section, with where it sits in the document it came from. */
export interface FindMatch {
  /** Enclosing headings, outermost first. Empty above the first heading. */
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
  /** Whether anything but the heading is here. See the filter below. */
  readonly hasBody: boolean;
}

/**
 * The best sections of a document for a query, best first, within a budget.
 *
 * Returns no matches for a query with no content words and for a document
 * where nothing clears the coverage floor. Both are answers rather than
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
  const terms = contentTokens(query);
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
        countTokenMatches(term, sectionTokens.body) +
        HEADING_WEIGHT_NEAREST * countTokenMatches(term, sectionTokens.nearest) +
        HEADING_WEIGHT_ANCESTOR * countTokenMatches(term, sectionTokens.ancestors),
    ),
  );

  // The document frequency is over this page's sections, which is the right
  // corpus rather than a poor substitute for a real one: it measures how
  // distinctive a term is *here*. It is what stops a page's own subject
  // words — "wal" and "sqlite" on sqlite.org/wal.html — from drowning the
  // rare term that actually locates the answer.
  //
  // The `1 +` is not decoration. Classic BM25 IDF goes negative once a term
  // appears in more than half the corpus, and with a corpus of twenty
  // sections that is ordinary — a section would be penalised for containing
  // a word the caller asked for.
  const idf = terms.map((_, index) => {
    const df = frequencies.reduce((count, row) => count + ((row[index] ?? 0) > 0 ? 1 : 0), 0);
    return Math.log(1 + (sections.length - df + 0.5) / (df + 0.5));
  });

  const scored = sections.map((section, index): ScoredSection => {
    const row = frequencies[index] ?? [];
    const normalization = BM25_K1 * (1 - BM25_B + (BM25_B * (lengths[index] ?? LENGTH_FLOOR)) / averageLength);

    let score = 0;
    let present = 0;
    for (let term = 0; term < terms.length; term++) {
      const frequency = row[term] ?? 0;
      if (frequency <= 0) continue;
      present++;
      score += (idf[term] ?? 0) * (frequency / (frequency + normalization));
    }

    return {
      section,
      score,
      coverage: present / terms.length,
      hasBody: (tokens[index]?.body.length ?? 0) > 0,
    };
  });

  const ranked = scored
    // A section holding nothing but its own heading has no content to
    // return, and the length floor alone does not stop it winning: a
    // three-word heading that is entirely query terms is the densest thing
    // on the page. Its descriptive power is not lost — it weighs on every
    // section beneath it as an ancestor, which is where it belongs.
    .filter((entry) => entry.hasBody && entry.coverage >= COVERAGE_FLOOR)
    // Offset breaks a tie, so the same page and query always select the same
    // sections in the same order.
    .sort((a, b) => b.score - a.score || a.section.start - b.section.start);

  return { matches: select(markdown, ranked, maxChars), navigable };
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
    body: tokenize(section.text.replace(LEADING_HEADING, "")),
    nearest: tokenize(section.headings.at(-1) ?? ""),
    ancestors: tokenize(section.headings.slice(0, -1).join(" ")),
  };
}

/**
 * Fills the budget in score order, cutting only the last section taken.
 *
 * Whole sections are the point: an excerpt cropped around a keyword loses
 * the sentence that set it up and the one that qualifies it, while a section
 * is a unit the author chose to be self-contained. Measured across five real
 * reference pages, one section in 134 exceeds a 6,000-character budget, so
 * this cuts rarely — and the pages where it cuts hard are the ones an
 * outline already reports as not worth navigating.
 */
function select(markdown: string, ranked: ScoredSection[], maxChars: number): FindMatch[] {
  const matches: FindMatch[] = [];
  let remaining = maxChars;

  for (const { section, coverage } of ranked) {
    // A sliver of budget buys a fragment nobody can read.
    if (remaining < MIN_MATCH_CHARS) break;

    const whole = section.text.length <= remaining;
    const text = whole ? section.text : safeSlice(markdown, section, remaining);
    if (text.trim().length === 0) continue;

    // Backstop, now that safeSlice falls back to a hard cut: only a budget
    // in the narrow band just above MIN_MATCH_CHARS can still produce a
    // fragment. Skip it and let a smaller whole section have the room.
    //
    // Only cuts are judged this way. A whole section is complete at any
    // length, and completeness is the property this operation sells.
    if (!whole && text.length < MIN_MATCH_CHARS) continue;

    matches.push({
      path: [...section.headings],
      offset: section.start,
      coverage: Math.round(coverage * 100) / 100,
      markdown: text,
      chars: text.length,
      sectionChars: section.text.length,
      truncated: text.length < section.text.length,
    });
    remaining -= text.length;
  }

  // Skipping every candidate would say "no section covered this query" about
  // a page where several did — the budget was simply smaller than any of
  // them. That is the one thing an empty result must never mean, since the
  // whole contract is that empty is an answer. Take the best one cut hard.
  if (matches.length === 0 && ranked[0]) {
    const { section, coverage } = ranked[0];
    const text = hardCut(markdown.slice(section.start, section.start + maxChars));
    if (text.trim().length > 0) {
      matches.push({
        path: [...section.headings],
        offset: section.start,
        coverage: Math.round(coverage * 100) / 100,
        markdown: text,
        chars: text.length,
        sectionChars: section.text.length,
        truncated: true,
      });
    }
  }

  return matches;
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
function safeSlice(markdown: string, section: Section, budget: number): string {
  const safe = markdown.slice(section.start, safeCut(markdown, section.start, section.start, budget)).trimEnd();
  if (safe.length >= MIN_MATCH_CHARS) return safe;
  return hardCut(markdown.slice(section.start, section.start + budget));
}

/** Trims a slice back to a word boundary, so it ends mid-sentence not mid-word. */
function hardCut(slice: string): string {
  const space = slice.lastIndexOf(" ");
  return (space > slice.length / 2 ? slice.slice(0, space) : slice).trimEnd();
}

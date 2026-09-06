import { describe, expect, it } from "vitest";
import type { FindMatch } from "./find.js";
import { COVERAGE_FLOOR, findContentTokens, findSections, LENGTH_FLOOR, MIN_MATCH_CHARS } from "./find.js";
import { buildOutline } from "./sections.js";

/** Most tests here are about which sections come back, not about structure. */
const matchesIn = (markdown: string, query: string, maxChars: number): FindMatch[] =>
  findSections(markdown, query, maxChars).matches;

/** Prose long enough that a section is not scored as a heading fragment. */
function filler(topic: string, sentences = 6): string {
  return Array.from({ length: sentences }, (_, index) => `A sentence about ${topic}, number ${index}.`).join(" ");
}

const PAGE = [
  "# Write-Ahead Logging",
  "",
  filler("the database in general"),
  "",
  "## Overview",
  "",
  filler("how the database stores pages"),
  "",
  "## Checkpointing",
  "",
  `Checkpoint starvation happens when readers never let the checkpoint finish. ${filler("checkpoints", 5)}`,
  "",
  "## Read-Only Databases",
  "",
  filler("opening a database without writing"),
].join("\n");

describe("find token normalization", () => {
  it("stems ASCII-Latin prose while preserving non-Latin and identifier terms", () => {
    expect(findContentTokens("Queries running checkpointing")).toEqual(["queri", "run", "checkpoint"]);
    expect(findContentTokens("машины 日本語 busy_timeout")).toEqual(["машины", "日本語", "busy_timeout"]);
  });

  it("matches inflected prose without treating unrelated prefixes as equivalent", () => {
    const page = [
      "# Reference",
      "",
      "## Morphology",
      "",
      `${filler("queries running through checkpointing", 6)}`,
      "",
      "## Similar-looking words",
      "",
      `${filler("timeouts and busy handlers", 6)}`,
    ].join("\n");

    expect(matchesIn(page, "query run checkpoint", 6_000)[0]?.path.at(-1)).toBe("Morphology");
    expect(matchesIn(page, "time", 6_000)).toEqual([]);
    expect(matchesIn(page, "busy_timeout", 6_000)).toEqual([]);
  });
});

describe("findSections", () => {
  it("returns the section that answers the query, not the one that repeats the topic", () => {
    const matches = matchesIn(PAGE, "checkpoint starvation", 6_000);

    expect(matches[0]?.path).toEqual(["Write-Ahead Logging", "Checkpointing"]);
    expect(matches[0]?.markdown).toContain("Checkpoint starvation happens");
  });

  it("prefers the rare term over the page's own subject word", () => {
    // The whole reason document frequency is computed over this page's own
    // sections: "database" is everywhere here and locates nothing, while
    // "starvation" appears once and locates the answer exactly. Without
    // in-page IDF the longest section mentioning "database" would win.
    const matches = matchesIn(PAGE, "database starvation", 6_000);

    expect(matches[0]?.path.at(-1)).toBe("Checkpointing");
  });

  it("carries the whole heading path, since a ranked list has no order to imply it", () => {
    const matches = matchesIn(PAGE, "checkpoint starvation", 6_000);

    // "Checkpointing" alone would be ambiguous on a page with several
    // chapters. In an outline the reader infers the path from position;
    // here there is no position to infer from.
    expect(matches[0]?.path[0]).toBe("Write-Ahead Logging");
  });

  it("returns whole sections, and says so", () => {
    const matches = matchesIn(PAGE, "checkpoint starvation", 6_000);

    expect(matches[0]?.truncated).toBe(false);
    expect(matches[0]?.chars).toBe(matches[0]?.sectionChars);
  });

  it("cuts only the last section the budget reaches", () => {
    const matches = matchesIn(PAGE, "checkpoint starvation database overview", 700);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.slice(0, -1).every((match) => !match.truncated)).toBe(true);
    const returned = matches.reduce((total, match) => total + match.chars, 0);
    expect(returned).toBeLessThanOrEqual(700);
  });

  it("never returns a cut smaller than a paragraph", () => {
    // Found live rather than reasoned about: against sqlite.org/wal.html
    // with a 1,500-character budget, matches two and three came back as 41
    // and 43 characters — the heading line and nothing else. safeCut takes a
    // line boundary outside a fence "even when it wastes most of the
    // budget", which is right for a window that continues at nextOffset and
    // wrong here, where nothing continues.
    //
    // The shape that caused it: a first match large enough to eat most of
    // the budget, leaving the rest a stub.
    const page = [
      "# Guide",
      "",
      "## Checkpointing in detail",
      "",
      filler("checkpoint starvation and how it stalls the log", 40),
      "",
      "## Checkpoint notes",
      "",
      filler("checkpoint starvation seen from another angle", 20),
      "",
      "## Checkpoint asides",
      "",
      filler("checkpoint starvation once more", 20),
    ].join("\n");

    const matches = matchesIn(page, "checkpoint starvation", 1_500);

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      if (match.truncated) expect(match.chars).toBeGreaterThanOrEqual(MIN_MATCH_CHARS);
    }
  });

  it("keeps a whole section of any size, because completeness is the point", () => {
    // The counterpart to the rule above: the floor judges cuts, not whole
    // sections. A short section returned entire is complete, and complete is
    // what this operation sells.
    const page = [
      "# Guide",
      "",
      filler("general matters", 20),
      "",
      "## Checkpoint starvation",
      "",
      "It stalls the log.",
    ].join("\n");

    const [match] = matchesIn(page, "checkpoint starvation", 6_000);

    expect(match?.truncated).toBe(false);
    expect(match?.chars).toBeLessThan(MIN_MATCH_CHARS);
    expect(match?.markdown).toContain("It stalls the log.");
  });

  it("returns the best section cut, rather than nothing, when none of them fit", () => {
    // The distinction the whole contract rests on: empty must mean "no
    // section covered this query", never "no section fit the budget". A page
    // of large sections against a small budget used to return nothing, which
    // says something false about the page.
    const page = [
      "# Guide",
      "",
      "## Checkpointing",
      "",
      filler("checkpoint starvation and how it stalls the log", 40),
    ].join("\n");

    const matches = matchesIn(page, "checkpoint starvation", 600);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.truncated).toBe(true);
    expect(matches[0]?.chars).toBeGreaterThan(400);
    expect(matches[0]?.chars).toBeLessThanOrEqual(600);
    // And the caller can still go read the rest of it.
    expect(matches[0]?.offset).toBeGreaterThanOrEqual(0);
    expect(matches[0]?.sectionChars).toBeGreaterThan(matches[0]?.chars ?? 0);
  });

  it("spends no more than the budget", () => {
    const matches = matchesIn(PAGE, "checkpoint starvation database overview", 6_000);
    const returned = matches.reduce((total, match) => total + match.chars, 0);

    expect(returned).toBeLessThanOrEqual(6_000);
  });

  it("returns nothing when the page does not discuss the query", () => {
    // The off-target failure one layer down. Returning the best three
    // sections here would be a confident answer to a question this document
    // cannot answer.
    expect(matchesIn(PAGE, "kubernetes ingress controller", 6_000)).toEqual([]);
  });

  it("returns nothing for a query with no content words", () => {
    // Coverage reports 1 for a query with no tokens — "nothing to be
    // off-target about" — so scoring one would rank the page arbitrarily
    // and call it a match.
    expect(matchesIn(PAGE, "the and of", 6_000)).toEqual([]);
  });

  it("reports coverage as the fraction of query words present", () => {
    const [match] = matchesIn(PAGE, "checkpoint starvation", 6_000);

    expect(match?.coverage).toBe(1);
    expect(matchesIn(PAGE, "checkpoint starvation kubernetes", 6_000)[0]?.coverage).toBeCloseTo(0.67, 2);
  });

  it("keeps every match at or above the coverage floor", () => {
    const matches = matchesIn(PAGE, "checkpoint starvation overview", 6_000);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((match) => match.coverage >= COVERAGE_FLOOR)).toBe(true);
  });

  it("does not let a heading-only section outrank the prose beneath it", () => {
    // splitSections keeps any section with non-whitespace text, so two
    // adjacent headings leave one that is nothing but a heading. Short plus
    // a weighted heading hit reads as extremely dense, and without the
    // length floor it wins while containing no answer.
    const page = [
      "# Checkpoint starvation",
      "",
      "## Details",
      "",
      `Checkpoint starvation is what happens here. ${filler("starving checkpoints")}`,
    ].join("\n");

    const matches = matchesIn(page, "checkpoint starvation", 6_000);

    expect(matches[0]?.path.at(-1)).toBe("Details");
    expect(matches[0]?.chars).toBeGreaterThan(LENGTH_FLOOR);
  });

  it("weights a heading above the same word buried in prose", () => {
    const page = [
      "# Guide",
      "",
      "## Checkpointing",
      "",
      filler("the mechanism", 8),
      "",
      "## Something else",
      "",
      `${filler("other things", 6)} Checkpointing is mentioned once here.`,
    ].join("\n");

    expect(matchesIn(page, "checkpointing", 6_000)[0]?.path.at(-1)).toBe("Checkpointing");
  });

  it("scores an unstructured page as the single section it is", () => {
    // The measured degenerate case: an essay with no headings is one
    // section, so find returns one truncated match and is no better than a
    // read. Worth pinning, because it is what `navigable: false` predicts.
    const page = `${filler("checkpoint starvation", 60)}`;
    const matches = matchesIn(page, "checkpoint starvation", 600);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.truncated).toBe(true);
    expect(matches[0]?.offset).toBe(0);
  });

  it("never cuts inside a fenced code block", () => {
    const page = [
      "# Config",
      "",
      "## Checkpoint settings",
      "",
      filler("configuring checkpoints", 4),
      "",
      "```sql",
      ...Array.from({ length: 40 }, (_, i) => `PRAGMA wal_checkpoint(${i}); -- checkpoint starvation`),
      "```",
    ].join("\n");

    const [match] = matchesIn(page, "checkpoint starvation", 700);
    const fences = (match?.markdown.match(/```/g) ?? []).length;

    expect(match?.truncated).toBe(true);
    expect(fences % 2).toBe(0);
  });

  it("is stable: the same page and query select the same sections in the same order", () => {
    const once = matchesIn(PAGE, "checkpoint database overview", 2_000);
    const twice = matchesIn(PAGE, "checkpoint database overview", 2_000);

    expect(once.map((match) => match.offset)).toEqual(twice.map((match) => match.offset));
  });

  it("survives a document with no headings at all and a query it matches", () => {
    const matches = matchesIn(filler("checkpoint starvation", 20), "checkpoint starvation", 6_000);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toEqual([]);
  });

  it("returns nothing for an empty document", () => {
    expect(matchesIn("", "checkpoint starvation", 6_000)).toEqual([]);
  });
});

describe("findSections inside an oversized section", () => {
  /** The shape that started this: one section far bigger than any budget. */
  const buried = [
    "# Reference",
    "",
    "## List Of Everything",
    "",
    filler("analysis_limit and what it does", 12),
    "",
    filler("auto_vacuum and its modes", 12),
    "",
    `The busy_timeout pragma sets how long a connection waits on a lock. ${filler("busy timeouts", 6)}`,
    "",
    filler("cache_size and memory use", 12),
  ].join("\n");

  it("returns the part of the section that matches, not its opening", () => {
    // Previously this scored the section on a term near its end and then
    // returned its beginning — text chosen without reference to the query.
    // Against sqlite.org/pragma.html that meant answering a `busy_timeout`
    // question with the paragraph about `analysis_limit`.
    const [match] = matchesIn(buried, "busy_timeout", 900);

    expect(match?.markdown).toContain("busy_timeout pragma sets how long");
    expect(match?.markdown).not.toContain("analysis_limit");
    expect(match?.truncated).toBe(true);
    expect(match?.offset).toBeGreaterThan(0);
  });

  it("reports coverage of what it returned, so the number is about the text you got", () => {
    const [match] = matchesIn(buried, "busy_timeout", 900);

    // The old number described the whole section, most of which was never
    // sent. Now it describes the excerpt, and it is high because the excerpt
    // is the matching part rather than in spite of it.
    expect(match?.coverage).toBe(1);
    expect(match?.markdown).toContain("busy_timeout");
  });

  it("still reads the offset back to the same text with extract", () => {
    const [match] = matchesIn(buried, "busy_timeout", 900);
    const at = match?.offset ?? 0;

    expect(buried.slice(at, at + (match?.chars ?? 0))).toBe(match?.markdown);
  });

  it("merges chosen blocks that turn out to be neighbours", () => {
    // Merging is presentation, not selection: blocks are picked on score and
    // any that are adjacent are emitted as one excerpt, so a passage split
    // across a blank line does not arrive as two unrelated quotations.
    const page = [
      "# Guide",
      "",
      "## Everything",
      "",
      filler("unrelated matters", 30),
      "",
      "Checkpoint starvation stalls the log.",
      "",
      "That starvation is why the checkpoint never completes.",
      "",
      filler("other unrelated matters", 30),
    ].join("\n");

    // Small enough that the section cannot come back whole, so the blocks
    // are what get chosen.
    const matches = matchesIn(page, "checkpoint starvation", 400);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.markdown).toContain("stalls the log");
    expect(matches[0]?.markdown).toContain("never completes");
    // One excerpt, not two, and the blank line between them is kept.
    expect(matches[0]?.markdown).not.toContain("unrelated");
  });

  it("does not pad the budget with blocks that hold none of the query", () => {
    const page = [
      "# Guide",
      "",
      "## Everything",
      "",
      `Checkpoint starvation is the problem. ${filler("starvation", 4)}`,
      "",
      filler("something else entirely", 120),
    ].join("\n");

    // Budget is ample; the point is that leftover room is not filled with
    // text that happens to fit.
    const matches = matchesIn(page, "checkpoint starvation", 4_000);
    const text = matches.map((match) => match.markdown).join("\n");

    expect(text).toContain("Checkpoint starvation is the problem");
    expect(text).not.toContain("something else entirely");
  });
});

describe("findSections and Markdown escaping", () => {
  /** How a renderer actually writes an identifier: the underscore escaped. */
  const escaped = [
    "# Pragmas",
    "",
    "## analysis\\_limit",
    "",
    filler("the analysis limit and what it bounds", 12),
    "",
    "## busy\\_timeout",
    "",
    `**PRAGMA busy\\_timeout;** sets how long a connection waits on a lock. ${filler("waiting", 6)}`,
  ].join("\n");

  it("finds an identifier the page wrote with an escaped underscore", () => {
    // Regression: rendered Markdown escapes `_`, so ICU split the document's
    // `busy\_timeout` into "busy" and "_timeout" while the query stayed one
    // token. Exact comparison then missed a page documenting it in full. The
    // old prefix rule matched "busy" — the right answer for an unsound
    // reason, which is why replacing that rule exposed this.
    const [match] = matchesIn(escaped, "busy_timeout", 6_000);

    // The path is the document's own heading text, escape and all: only the
    // token stream is normalized, never what comes back.
    expect(match?.path.at(-1)).toBe("busy\\_timeout");
    expect(match?.coverage).toBe(1);
  });

  it("accepts a query written the escaped way too", () => {
    // Both sides are normalized, because the invariant is that the query and
    // the document are compared as the same characters.
    expect(matchesIn(escaped, "busy\\_timeout", 6_000)[0]?.path.at(-1)).toBe("busy\\_timeout");
  });

  it("still tells two identifiers on the same page apart", () => {
    // Unescaping must not blur them back together.
    expect(matchesIn(escaped, "analysis_limit", 6_000)[0]?.path.at(-1)).toBe("analysis\\_limit");
  });

  it("leaves a backslash that is not a Markdown escape alone", () => {
    // `\d` in a code block is a regex, not an escaped letter. Stripping every
    // backslash would corrupt snippets and silently change what matches.
    const page = [
      "# Guide",
      "",
      "## Matching digits",
      "",
      `Use the pattern \`\\d+\` to match digits. ${filler("digit matching", 8)}`,
    ].join("\n");

    expect(matchesIn(page, "digits", 6_000)).toHaveLength(1);
    // The returned Markdown is never rewritten — only tokenization is.
    expect(matchesIn(page, "digits", 6_000)[0]?.markdown).toContain("\\d+");
  });

  it("does not rewrite the Markdown it returns", () => {
    const [match] = matchesIn(escaped, "busy_timeout", 6_000);

    // Escapes still render as their author intended; only the token stream
    // was normalized.
    expect(match?.markdown).toContain("busy\\_timeout");
  });
});

describe("findSections navigable", () => {
  it("reports the same structure verdict outline does", () => {
    // One predicate, one split. If these ever disagree, a caller is being
    // told two different things about the same page.
    for (const page of [PAGE, filler("one long block of prose", 60), "", "# Only\n\nA heading and a line."]) {
      expect(findSections(page, "prose sentence", 6_000).navigable).toBe(buildOutline(page).navigable);
    }
  });

  it("says a page had no structure to search, so a miss can be read correctly", () => {
    // The failure this exists for: an unstructured page returns one match
    // that is the top of one enormous section, wearing a confident coverage
    // score. Agents could not tell that from a targeted selection.
    const flat = filler("checkpoint starvation and the log", 80);
    const found = findSections(flat, "checkpoint starvation", 1_000);

    expect(found.navigable).toBe(false);
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]?.truncated).toBe(true);
  });

  it("says a structured page was searchable, so a miss means what it says", () => {
    const found = findSections(PAGE, "kubernetes ingress controller", 6_000);

    expect(found.navigable).toBe(true);
    expect(found.matches).toEqual([]);
  });
});

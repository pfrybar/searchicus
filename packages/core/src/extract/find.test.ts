import { describe, expect, it } from "vitest";
import { countTokenMatches } from "../relevance.js";
import { COVERAGE_FLOOR, findSections, LENGTH_FLOOR, MIN_MATCH_CHARS } from "./find.js";

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

describe("findSections", () => {
  it("returns the section that answers the query, not the one that repeats the topic", () => {
    const matches = findSections(PAGE, "checkpoint starvation", 6_000);

    expect(matches[0]?.path).toEqual(["Write-Ahead Logging", "Checkpointing"]);
    expect(matches[0]?.markdown).toContain("Checkpoint starvation happens");
  });

  it("prefers the rare term over the page's own subject word", () => {
    // The whole reason document frequency is computed over this page's own
    // sections: "database" is everywhere here and locates nothing, while
    // "starvation" appears once and locates the answer exactly. Without
    // in-page IDF the longest section mentioning "database" would win.
    const matches = findSections(PAGE, "database starvation", 6_000);

    expect(matches[0]?.path.at(-1)).toBe("Checkpointing");
  });

  it("carries the whole heading path, since a ranked list has no order to imply it", () => {
    const matches = findSections(PAGE, "checkpoint starvation", 6_000);

    // "Checkpointing" alone would be ambiguous on a page with several
    // chapters. In an outline the reader infers the path from position;
    // here there is no position to infer from.
    expect(matches[0]?.path[0]).toBe("Write-Ahead Logging");
  });

  it("returns whole sections, and says so", () => {
    const matches = findSections(PAGE, "checkpoint starvation", 6_000);

    expect(matches[0]?.truncated).toBe(false);
    expect(matches[0]?.chars).toBe(matches[0]?.sectionChars);
  });

  it("cuts only the last section the budget reaches", () => {
    const matches = findSections(PAGE, "checkpoint starvation database overview", 700);

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

    const matches = findSections(page, "checkpoint starvation", 1_500);

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

    const [match] = findSections(page, "checkpoint starvation", 6_000);

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

    const matches = findSections(page, "checkpoint starvation", 600);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.truncated).toBe(true);
    expect(matches[0]?.chars).toBeGreaterThan(400);
    expect(matches[0]?.chars).toBeLessThanOrEqual(600);
    // And the caller can still go read the rest of it.
    expect(matches[0]?.offset).toBeGreaterThanOrEqual(0);
    expect(matches[0]?.sectionChars).toBeGreaterThan(matches[0]?.chars ?? 0);
  });

  it("spends no more than the budget", () => {
    const matches = findSections(PAGE, "checkpoint starvation database overview", 6_000);
    const returned = matches.reduce((total, match) => total + match.chars, 0);

    expect(returned).toBeLessThanOrEqual(6_000);
  });

  it("returns nothing when the page does not discuss the query", () => {
    // The off-target failure one layer down. Returning the best three
    // sections here would be a confident answer to a question this document
    // cannot answer.
    expect(findSections(PAGE, "kubernetes ingress controller", 6_000)).toEqual([]);
  });

  it("returns nothing for a query with no content words", () => {
    // Coverage reports 1 for a query with no tokens — "nothing to be
    // off-target about" — so scoring one would rank the page arbitrarily
    // and call it a match.
    expect(findSections(PAGE, "the and of", 6_000)).toEqual([]);
  });

  it("reports coverage as the fraction of query words present", () => {
    const [match] = findSections(PAGE, "checkpoint starvation", 6_000);

    expect(match?.coverage).toBe(1);
    expect(findSections(PAGE, "checkpoint starvation kubernetes", 6_000)[0]?.coverage).toBeCloseTo(0.67, 2);
  });

  it("keeps every match at or above the coverage floor", () => {
    const matches = findSections(PAGE, "checkpoint starvation overview", 6_000);

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

    const matches = findSections(page, "checkpoint starvation", 6_000);

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

    expect(findSections(page, "checkpointing", 6_000)[0]?.path.at(-1)).toBe("Checkpointing");
  });

  it("scores an unstructured page as the single section it is", () => {
    // The measured degenerate case: an essay with no headings is one
    // section, so find returns one truncated match and is no better than a
    // read. Worth pinning, because it is what `navigable: false` predicts.
    const page = `${filler("checkpoint starvation", 60)}`;
    const matches = findSections(page, "checkpoint starvation", 600);

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

    const [match] = findSections(page, "checkpoint starvation", 700);
    const fences = (match?.markdown.match(/```/g) ?? []).length;

    expect(match?.truncated).toBe(true);
    expect(fences % 2).toBe(0);
  });

  it("is stable: the same page and query select the same sections in the same order", () => {
    const once = findSections(PAGE, "checkpoint database overview", 2_000);
    const twice = findSections(PAGE, "checkpoint database overview", 2_000);

    expect(once.map((match) => match.offset)).toEqual(twice.map((match) => match.offset));
  });

  it("survives a document with no headings at all and a query it matches", () => {
    const matches = findSections(filler("checkpoint starvation", 20), "checkpoint starvation", 6_000);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toEqual([]);
  });

  it("returns nothing for an empty document", () => {
    expect(findSections("", "checkpoint starvation", 6_000)).toEqual([]);
  });
});

describe("countTokenMatches", () => {
  it("counts occurrences rather than answering presence", () => {
    expect(countTokenMatches("checkpoint", ["checkpoint", "starvation", "checkpoint"])).toBe(2);
    expect(countTokenMatches("checkpoint", ["starvation"])).toBe(0);
  });

  it("matches prefixes exactly where the coverage rule does", () => {
    // The two must agree, or a section could rank first while reporting that
    // it covers none of the query.
    expect(countTokenMatches("review", ["reviews"])).toBe(1);
    expect(countTokenMatches("reviews", ["review"])).toBe(1);
    // Under four characters, prefixes are too promiscuous to mean anything.
    expect(countTokenMatches("wal", ["walrus"])).toBe(0);
    expect(countTokenMatches("wal", ["wal"])).toBe(1);
  });
});

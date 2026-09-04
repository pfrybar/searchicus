import { describe, expect, it } from "vitest";
import {
  assessRelevance,
  contentTokens,
  queryTokenCoverage,
  relevanceMatch,
  RELEVANCE_THRESHOLD,
  tokenize,
} from "./relevance.js";
import type { SearchResult } from "./types.js";

function result(title: string, snippet = "", url = "https://example.com/x"): SearchResult {
  return { title, snippet, url, source: "test" };
}

/** The real failure: every result answers only the query's first term. */
const firstTermOnly = [
  result("Best Buy | Official Online Store", "Shop Best Buy for electronics.", "https://www.bestbuy.com/"),
  result("Best Western Hotels", "Book your stay at Best Western.", "https://www.bestwestern.com/"),
  result("The 50 Best Movies of All Time", "Our critics pick the best films.", "https://example.org/best-movies"),
];

const onTarget = [
  result(
    "Six Flags Hurricane Harbor Chicago",
    "The largest waterpark in the Chicago area.",
    "https://www.sixflags.com/hurricaneharborchicago",
  ),
  result("10 Best Waterparks Near Chicago", "Our guide to Chicago waterparks.", "https://example.org/chicago-water"),
  result("Waterpark hotels in Chicago", "Indoor waterparks for families.", "https://example.net/waterpark-chicago"),
];

describe("tokenize", () => {
  it("lowercases and splits on punctuation", () => {
    expect(tokenize("Best Waterpark, in Chicago!")).toEqual(["best", "waterpark", "in", "chicago"]);
  });

  it("strips accents so accented text still matches", () => {
    expect(tokenize("Café Münchén")).toEqual(["cafe", "munchen"]);
  });

  it("returns nothing for punctuation alone", () => {
    expect(tokenize("!!! ---")).toEqual([]);
  });
});

describe("contentTokens", () => {
  it("drops function words that carry no topic", () => {
    expect(contentTokens("best waterpark in chicago")).toEqual(["best", "waterpark", "chicago"]);
  });

  it("de-duplicates repeated tokens", () => {
    expect(contentTokens("chicago chicago pizza")).toEqual(["chicago", "pizza"]);
  });

  it("keeps nothing for a query of pure stopwords", () => {
    expect(contentTokens("what is the")).toEqual([]);
  });
});

describe("queryTokenCoverage", () => {
  it("scores a good result set near 1", () => {
    expect(queryTokenCoverage("best waterpark in chicago", onTarget)).toBe(1);
  });

  it("collapses on the first-term-only page this gate exists for", () => {
    // Only "best" is present, out of best/waterpark/chicago.
    expect(queryTokenCoverage("best waterpark in chicago", firstTermOnly)).toBeCloseTo(1 / 3, 5);
  });

  it("scores 0 when there are no results", () => {
    expect(queryTokenCoverage("anything", [])).toBe(0);
  });

  it("scores 1 when the query has no content tokens to check", () => {
    expect(queryTokenCoverage("what is the", [])).toBe(1);
  });

  it("counts a token found only in the URL", () => {
    expect(queryTokenCoverage("kubernetes", [result("Docs", "", "https://example.com/kubernetes/intro")])).toBe(1);
  });

  it("matches across simple plurals", () => {
    expect(queryTokenCoverage("waterpark", [result("Chicago waterparks")])).toBe(1);
    expect(queryTokenCoverage("waterparks", [result("A waterpark guide")])).toBe(1);
  });

  it("does not let short tokens match by prefix", () => {
    // "go" must not be satisfied by "google" — three-character-and-under
    // prefixes match far too much.
    expect(queryTokenCoverage("go", [result("Google Search")])).toBe(0);
  });
});

describe("relevanceMatch", () => {
  it("is high when every result is individually on topic", () => {
    expect(relevanceMatch("waterpark chicago", onTarget)).toBeGreaterThan(0.8);
  });

  it("is low when results only collectively mention the query", () => {
    const spread = [result("All about waterparks"), result("Chicago city guide")];
    // Coverage is 1 (both tokens appear somewhere) but no single result has both.
    expect(queryTokenCoverage("waterpark chicago", spread)).toBe(1);
    expect(relevanceMatch("waterpark chicago", spread)).toBe(0.5);
  });

  it("scores 0 with no results", () => {
    expect(relevanceMatch("anything", [])).toBe(0);
  });
});

describe("assessRelevance", () => {
  it("passes a good result set", () => {
    const report = assessRelevance("best waterpark in chicago", onTarget);

    expect(report.offTarget).toBe(false);
    expect(report.coverage).toBe(1);
    expect(report.missing).toEqual([]);
  });

  it("flags the first-term-only page and names what went missing", () => {
    const report = assessRelevance("best waterpark in chicago", firstTermOnly);

    expect(report.offTarget).toBe(true);
    expect(report.missing).toEqual(["waterpark", "chicago"]);
  });

  it("catches a two-token query that matched only its first term", () => {
    // The tightest real case: 1 of 2 tokens is 0.5, which must still fail.
    const report = assessRelevance("docker debian", [result("Docker Desktop", "Install Docker on any platform.")]);

    expect(report.coverage).toBe(0.5);
    expect(report.offTarget).toBe(true);
  });

  it("tolerates a good page that misses one token out of three", () => {
    const report = assessRelevance("chicago deep dish pizza", [
      result("Chicago pizza guide", "The best deep-dish in town."),
    ]);

    expect(report.offTarget).toBe(false);
  });

  it("does not flag a query it cannot score", () => {
    expect(assessRelevance("what is the", []).offTarget).toBe(false);
  });

  it("honours an explicit threshold", () => {
    const lenient = assessRelevance("best waterpark in chicago", firstTermOnly, 0.3);
    expect(lenient.offTarget).toBe(false);

    const strict = assessRelevance("best waterpark in chicago", onTarget, 1.01);
    expect(strict.offTarget).toBe(true);
  });

  it("uses the documented default threshold", () => {
    expect(RELEVANCE_THRESHOLD).toBe(0.6);
  });
});

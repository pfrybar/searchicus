import { describe, expect, it } from "vitest";
import type { EngineSearchOutcome } from "./types.js";
import {
  canonicalizeUrl,
  DEFAULT_RANKED_LIMIT,
  MAX_SNIPPET_LENGTH,
  rankResults,
  RRF_K,
  type RankingEngine,
} from "./ranking.js";
import type { SearchResult } from "./types.js";

const engines: RankingEngine[] = [
  { id: "bing", indexFamily: "bing" },
  { id: "duckduckgo", indexFamily: "bing" },
  { id: "brave", indexFamily: "brave" },
  { id: "startpage", indexFamily: "google" },
];

function result(url: string, title = url, extras: Partial<SearchResult> = {}): SearchResult {
  return { title, url, source: "test", ...extras };
}

function outcome(engineId: string, results: SearchResult[]): EngineSearchOutcome {
  return {
    engineId,
    ok: true,
    tookMs: 1,
    response: { engine: engineId, query: { query: "cats" }, results, tookMs: 1 },
  };
}

function rank(outcomes: EngineSearchOutcome[], options: { searchId?: string; limit?: number } = {}) {
  return rankResults({ query: "cats" }, outcomes, {
    searchId: options.searchId ?? "search-abc123",
    engines,
    limit: options.limit,
  });
}

describe("canonicalizeUrl", () => {
  it("normalizes duplicate-only URL details while preserving meaningful parameters", () => {
    expect(canonicalizeUrl("HTTP://WWW.Example.com/path/?b=2&utm_source=newsletter&a=1#section")).toBe(
      "https://example.com/path?a=1&b=2",
    );
    expect(canonicalizeUrl("https://yelp.com/search?find_desc=waterpark&page=2&gclid=ad")).toBe(
      "https://yelp.com/search?find_desc=waterpark&page=2",
    );
  });

  it("leaves malformed and non-web URLs as exact-string keys", () => {
    expect(canonicalizeUrl("not a URL")).toBe("not a URL");
    expect(canonicalizeUrl("mailto:cats@example.com")).toBe("mailto:cats@example.com");
  });
});

describe("rankResults", () => {
  it("merges canonical URLs and counts correlated engines as one family vote", () => {
    const shared = "https://example.com/cats";
    const results = rank([
      outcome("bing", [result("http://www.example.com/cats/?utm_campaign=spring", "Bing title")]),
      outcome("duckduckgo", [result(shared, "DuckDuckGo title", { snippet: "A useful description" })]),
      outcome("brave", [
        result("https://brave.example/one"),
        result("https://brave.example/two"),
        result("https://brave.example/three"),
        result(shared, "Brave title"),
      ]),
    ]);

    const merged = results.find((item) => item.url.includes("example.com/cats"));
    expect(merged).toMatchObject({
      title: "Bing title",
      url: "http://www.example.com/cats/?utm_campaign=spring",
      snippet: "A useful description",
      bestSource: "bing",
      found: [
        { engineId: "bing", rank: 1 },
        { engineId: "duckduckgo", rank: 1 },
        { engineId: "brave", rank: 4 },
      ],
      families: ["bing", "brave"],
    });
    expect(merged?.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 4));
  });

  it("rewards independent-family agreement more than correlated-engine agreement", () => {
    const correlated = rank([
      outcome("bing", [result("https://example.com/cats")]),
      outcome("duckduckgo", [result("https://example.com/cats")]),
    ])[0];
    const independent = rank([
      outcome("bing", [result("https://example.com/cats")]),
      outcome("brave", [result("https://example.com/cats")]),
    ])[0];

    expect(independent?.score).toBeGreaterThan(correlated?.score ?? 0);
  });

  it("uses query coverage, then canonical URL, to break equal RRF scores", () => {
    const results = rank([
      outcome("bing", [result("https://z.example/dogs", "Dogs")]),
      outcome("brave", [result("https://a.example/cats", "Cats")]),
    ]);

    expect(results.map((item) => item.title)).toEqual(["Cats", "Dogs"]);
  });

  it("caps after merging at two results per normalized host and assigns shown ranks to refs", () => {
    const results = rank(
      [
        outcome("bing", [
          result("https://www.yelp.com/one", "Yelp one"),
          result("https://yelp.com/two", "Yelp two"),
          result("https://yelp.com/three", "Yelp three"),
          result("https://other.example/four", "Other four"),
        ]),
      ],
      { searchId: "public-id", limit: 3 },
    );

    expect(results.map((item) => item.title)).toEqual(["Yelp one", "Yelp two", "Other four"]);
    expect(results.map((item) => item.ref)).toEqual(["public-id-1", "public-id-2", "public-id-3"]);
  });

  it("applies the final output limit after ranking and truncates long snippets", () => {
    const longSnippet = "cats ".repeat(50);
    const results = rank(
      [
        outcome("bing", [
          result("https://first.example/cats", "Cats first", { snippet: longSnippet }),
          result("https://second.example/cats", "Cats second"),
        ]),
      ],
      { limit: 1 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toMatch(/…$/);
    expect(results[0]?.snippet?.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH + 1);
  });

  it("defaults to the merged result limit and safely ignores failed outcomes", () => {
    const results = rank([
      outcome(
        "bing",
        Array.from({ length: DEFAULT_RANKED_LIMIT + 1 }, (_, index) => result(`https://${index}.example/cats`)),
      ),
      { engineId: "brave", ok: false, tookMs: 1, errorKind: "unknown", error: "blocked" },
    ]);

    expect(results).toHaveLength(DEFAULT_RANKED_LIMIT);
  });

  it("uses an unknown engine's own id as its independent family", () => {
    const [merged] = rank([outcome("third-party", [result("https://example.com/cats")])]);

    expect(merged?.families).toEqual(["third-party"]);
  });

  it("rejects unusable result limits and search ids", () => {
    expect(() => rank([], { limit: 0 })).toThrow(/limit must be a positive integer/);
    expect(() => rank([], { searchId: "" })).toThrow(/searchId must not be empty/);
  });
});

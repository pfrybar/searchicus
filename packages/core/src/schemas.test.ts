import { describe, expect, it } from "vitest";
import { MAX_SEARCH_LIMIT, SearchQuerySchema, SearchRequestSchema } from "./schemas.js";

describe("SearchQuerySchema", () => {
  it("accepts a minimal valid query", () => {
    const result = SearchQuerySchema.safeParse({ query: "cats" });
    expect(result.success).toBe(true);
  });

  it("trims a query and rejects an empty or whitespace-only string", () => {
    expect(SearchQuerySchema.parse({ query: "  cats  " }).query).toBe("cats");
    expect(SearchQuerySchema.safeParse({ query: "" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ query: "   " }).success).toBe(false);
  });

  it("rejects a missing query field", () => {
    const result = SearchQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("SearchRequestSchema", () => {
  it("accepts an optional final result limit and engine selection", () => {
    const result = SearchRequestSchema.safeParse({ query: "cats", limit: 5, engines: ["bing", "docs"] });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid final result limit", () => {
    expect(SearchRequestSchema.safeParse({ query: "cats", limit: 0 }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "cats", limit: MAX_SEARCH_LIMIT }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ query: "cats", limit: MAX_SEARCH_LIMIT + 1 }).success).toBe(false);
  });

  it("rejects malformed, empty, and duplicate engine selections", () => {
    expect(SearchRequestSchema.safeParse({ query: "cats", engines: ["bing", 1] }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "cats", engines: [] }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "cats", engines: ["bing", "bing"] }).success).toBe(false);
  });
});

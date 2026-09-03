import { describe, expect, it } from "vitest";
import { SearchQuerySchema, SearchRequestSchema } from "./schemas.js";

describe("SearchQuerySchema", () => {
  it("accepts a minimal valid query", () => {
    const result = SearchQuerySchema.safeParse({ query: "cats" });
    expect(result.success).toBe(true);
  });

  it("accepts every optional field", () => {
    const result = SearchQuerySchema.safeParse({
      query: "cats",
      limit: 5,
      page: 2,
      filters: { lang: "en" },
    });
    expect(result.success).toBe(true);
  });

  it("trims a query and rejects an empty or whitespace-only string", () => {
    expect(SearchQuerySchema.parse({ query: "  cats  " }).query).toBe("cats");
    expect(SearchQuerySchema.safeParse({ query: "" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ query: "   " }).success).toBe(false);
  });

  it("rejects a missing query field", () => {
    const result = SearchQuerySchema.safeParse({ limit: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range limit", () => {
    const result = SearchQuerySchema.safeParse({ query: "cats", limit: 1000 });
    expect(result.success).toBe(false);
  });
});

describe("SearchRequestSchema", () => {
  it("accepts an optional list of engine ids", () => {
    const result = SearchRequestSchema.safeParse({ query: "cats", engines: ["mock", "docs"] });
    expect(result.success).toBe(true);
  });

  it("rejects malformed, empty, and duplicate engine selections", () => {
    expect(SearchRequestSchema.safeParse({ query: "cats", engines: ["mock", 1] }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "cats", engines: [] }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "cats", engines: ["mock", "mock"] }).success).toBe(false);
  });
});

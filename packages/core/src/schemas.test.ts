import { describe, expect, it } from "vitest";
import { SearchQuerySchema } from "./schemas.js";

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

  it("rejects an empty query string", () => {
    const result = SearchQuerySchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
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

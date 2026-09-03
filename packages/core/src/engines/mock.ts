import type { SearchEngine, SearchQuery, SearchResponse, SearchResult } from "../types.js";

/**
 * A deterministic, dependency-free SearchEngine used for development and
 * testing. It fabricates results from the query text so every surface
 * (CLI/API/MCP/UI) has something real to render before any actual backend
 * engine is plugged in.
 */
export class MockSearchEngine implements SearchEngine {
  readonly id = "mock";
  readonly name = "Mock Search Engine";

  async search(query: SearchQuery): Promise<SearchResponse> {
    const start = Date.now();
    const limit = query.limit ?? 10;
    const page = query.page ?? 1;

    const results: SearchResult[] = Array.from({ length: limit }, (_, i) => {
      const rank = (page - 1) * limit + i + 1;
      return {
        title: `${query.query} — result ${rank}`,
        url: `https://example.com/${slugify(query.query)}/${rank}`,
        snippet: `Mock result #${rank} for "${query.query}".`,
        source: this.id,
        score: Number((1 / rank).toFixed(4)),
      };
    });

    return {
      query,
      results,
      engine: this.id,
      tookMs: Date.now() - start,
    };
  }
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "result";
}

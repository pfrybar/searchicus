import type { SearchEngine, SearchQuery, SearchResponse, SearchResult } from "@searchicus/core";

/** A deterministic test double for API and MCP adapter tests. */
export class TestSearchEngine implements SearchEngine {
  readonly id = "test";
  readonly name = "Test Search Engine";

  async search(query: SearchQuery): Promise<SearchResponse> {
    const results: SearchResult[] = Array.from({ length: 10 }, (_, index) => ({
      title: `Test result ${index + 1}`,
      url: `https://result-${index + 1}.example.test/`,
      source: this.id,
    }));

    return { query, results, engine: this.id, tookMs: 0 };
  }
}

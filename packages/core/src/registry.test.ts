import { describe, expect, it } from "vitest";
import { SearchEngineRegistry, UnknownEngineError } from "./registry.js";
import type { SearchEngine, SearchQuery, SearchResponse, SearchResult } from "./types.js";

class TestSearchEngine implements SearchEngine {
  readonly name = "Test Search Engine";

  constructor(readonly id = "test") {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const results: SearchResult[] = Array.from({ length: 10 }, (_, index) => ({
      title: `Test result ${index + 1}`,
      url: `https://example.test/${index + 1}`,
      source: this.id,
    }));

    return { query, results, engine: this.id, tookMs: 0 };
  }
}

describe("SearchEngineRegistry", () => {
  it("registers and looks up engines by id", () => {
    const registry = new SearchEngineRegistry();
    const engine = new TestSearchEngine();
    registry.register(engine);

    expect(registry.has("test")).toBe(true);
    expect(registry.get("test")).toBe(engine);
    expect(registry.list()).toEqual([engine]);
  });

  it("throws UnknownEngineError for an unregistered engine", async () => {
    const registry = new SearchEngineRegistry();
    await expect(registry.search("nope", { query: "x" })).rejects.toBeInstanceOf(UnknownEngineError);
  });

  it("searchAll fans a query out across engines and reports failures individually", async () => {
    const registry = new SearchEngineRegistry({ throttle: null });
    registry.register(new TestSearchEngine());

    const outcomes = await registry.searchAll({ query: "typescript" }, ["test", "missing"]);

    expect(outcomes).toHaveLength(2);
    const testOutcome = outcomes.find((outcome) => outcome.engineId === "test");
    const missingOutcome = outcomes.find((outcome) => outcome.engineId === "missing");
    expect(testOutcome?.ok).toBe(true);
    if (testOutcome?.ok) expect(testOutcome.response.results).toHaveLength(10);
    expect(missingOutcome?.ok).toBe(false);
  });

  it("searchAll defaults to every registered engine", async () => {
    const registry = new SearchEngineRegistry({ throttle: null });
    registry.register(new TestSearchEngine());

    const outcomes = await registry.searchAll({ query: "defaults" });

    expect(outcomes.map((outcome) => outcome.engineId)).toEqual(["test"]);
  });
});

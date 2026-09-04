import { describe, expect, it } from "vitest";
import { AllEnginesFailedError, createDefaultRegistry, SearchEngineRegistry, UnknownEngineError } from "./registry.js";
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

  it("declares the index families used by merged ranking", () => {
    const families = Object.fromEntries(
      createDefaultRegistry()
        .list()
        .map((engine) => [engine.id, engine.indexFamily]),
    );

    expect(families).toEqual({ bing: "bing", brave: "brave", duckduckgo: "bing", startpage: "google" });
  });

  it("throws UnknownEngineError for an unregistered single-engine search", async () => {
    const registry = new SearchEngineRegistry();
    await expect(registry.searchOne("nope", { query: "x" })).rejects.toBeInstanceOf(UnknownEngineError);
  });

  it("returns one ranked response from the fan-out", async () => {
    const registry = new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine());

    const response = await registry.search({ query: "cats", limit: 1 });

    expect(response).toMatchObject({ query: { query: "cats" }, degraded: false });
    expect(response.searchId).toMatch(/^[0-9a-z]{13}$/);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.ref).toBe(`${response.searchId}-1`);
  });

  it("marks a partial fan-out as degraded without exposing its outcomes", async () => {
    const registry = new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine()).register({
      id: "broken",
      name: "Broken",
      search: async () => Promise.reject(new Error("blocked")),
    });

    const response = await registry.search({ query: "cats" });

    expect(response.degraded).toBe(true);
    expect(response).not.toHaveProperty("outcomes");
    expect(response.results).not.toHaveLength(0);
  });

  it("fails a merged search when every selected engine fails", async () => {
    const registry = new SearchEngineRegistry({ throttle: null }).register({
      id: "broken",
      name: "Broken",
      search: async () => Promise.reject(new Error("blocked")),
    });

    await expect(registry.search({ query: "cats" })).rejects.toBeInstanceOf(AllEnginesFailedError);
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

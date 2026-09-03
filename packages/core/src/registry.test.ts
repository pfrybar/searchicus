import { describe, expect, it } from "vitest";
import { MockSearchEngine } from "./engines/mock.js";
import { SearchEngineRegistry, UnknownEngineError } from "./registry.js";

describe("SearchEngineRegistry", () => {
  it("registers and looks up engines by id", () => {
    const registry = new SearchEngineRegistry();
    const mock = new MockSearchEngine();
    registry.register(mock);

    expect(registry.has("mock")).toBe(true);
    expect(registry.get("mock")).toBe(mock);
    expect(registry.list()).toEqual([mock]);
  });

  it("throws UnknownEngineError for an unregistered engine", async () => {
    const registry = new SearchEngineRegistry();
    await expect(registry.search("nope", { query: "x" })).rejects.toBeInstanceOf(UnknownEngineError);
  });

  it("searchAll fans a query out across engines and reports failures individually", async () => {
    const registry = new SearchEngineRegistry();
    registry.register(new MockSearchEngine());

    const outcomes = await registry.searchAll({ query: "typescript", limit: 3 }, ["mock", "missing"]);

    expect(outcomes).toHaveLength(2);
    const mockOutcome = outcomes.find((o) => o.engineId === "mock");
    const missingOutcome = outcomes.find((o) => o.engineId === "missing");
    expect(mockOutcome?.ok).toBe(true);
    if (mockOutcome?.ok) {
      expect(mockOutcome.response.results).toHaveLength(3);
    }
    expect(missingOutcome?.ok).toBe(false);
  });

  it("searchAll defaults to every registered engine", async () => {
    const registry = new SearchEngineRegistry();
    registry.register(new MockSearchEngine());

    const outcomes = await registry.searchAll({ query: "defaults" });

    expect(outcomes.map((o) => o.engineId)).toEqual(["mock"]);
  });
});

describe("MockSearchEngine", () => {
  it("produces `limit` deterministic results for a query", async () => {
    const engine = new MockSearchEngine();
    const response = await engine.search({ query: "hello world", limit: 2 });

    expect(response.engine).toBe("mock");
    expect(response.results).toHaveLength(2);
    expect(response.results[0]?.title).toContain("hello world");
    expect(response.results[0]?.url).toMatch(/^https:\/\/example\.com\//);
  });

  it("offsets ranks by page", async () => {
    const engine = new MockSearchEngine();
    const page2 = await engine.search({ query: "paging", limit: 5, page: 2 });

    expect(page2.results[0]?.title).toContain("result 6");
  });
});

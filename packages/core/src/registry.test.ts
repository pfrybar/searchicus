import { describe, expect, it } from "vitest";
import type { SearchArchive, SearchArchiveRecord } from "./archive.js";
import { AllEnginesFailedError, createDefaultRegistry, SearchEngineRegistry, UnknownEngineError } from "./registry.js";
import type { SearchEngine, SearchQuery, SearchResponse, SearchResult } from "./types.js";

class RecordingArchive implements SearchArchive {
  readonly records: SearchArchiveRecord[] = [];
  fail = false;

  async archive(record: SearchArchiveRecord): Promise<void> {
    this.records.push(record);
    if (this.fail) throw new Error("disk unavailable");
  }
}

function afterImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

  it("archives complete raw outcomes after returning the merged response", async () => {
    const archive = new RecordingArchive();
    const registry = new SearchEngineRegistry({ throttle: null, archive }).register(new TestSearchEngine()).register({
      id: "broken",
      name: "Broken",
      search: async () => Promise.reject(new Error("blocked")),
    });

    const response = await registry.search({ query: "cats" });
    expect(archive.records).toEqual([]);

    await afterImmediate();
    expect(registry.activeArchives).toBe(0);
    expect(archive.records).toHaveLength(1);
    expect(archive.records[0]).toMatchObject({
      searchId: response.searchId,
      query: { query: "cats" },
      engineIds: ["test", "broken"],
      response,
      outcomes: [
        { engineId: "test", ok: true },
        { engineId: "broken", ok: false, errorKind: "unknown" },
      ],
    });
  });

  it("drains queued archival after returning results", async () => {
    let finish!: () => void;
    const archive: SearchArchive = {
      archive: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    const registry = new SearchEngineRegistry({ throttle: null, archive }).register(new TestSearchEngine());

    await registry.search({ query: "cats" });
    const draining = registry.drain();
    await afterImmediate();
    expect(registry.activeArchives).toBe(1);

    finish();
    await draining;
    expect(registry.activeArchives).toBe(0);
  });

  it("never changes a successful search when archival fails", async () => {
    const archive = new RecordingArchive();
    archive.fail = true;
    const registry = new SearchEngineRegistry({ throttle: null, archive }).register(new TestSearchEngine());

    await expect(registry.search({ query: "cats" })).resolves.toMatchObject({ query: { query: "cats" } });
    await registry.drain();
    expect(registry.activeArchives).toBe(0);
  });

  it("fails a merged search when every selected engine fails", async () => {
    const archive = new RecordingArchive();
    const registry = new SearchEngineRegistry({ throttle: null, archive }).register({
      id: "broken",
      name: "Broken",
      search: async () => Promise.reject(new Error("blocked")),
    });

    await expect(registry.search({ query: "cats" })).rejects.toBeInstanceOf(AllEnginesFailedError);
    await registry.drain();
    expect(archive.records).toMatchObject([
      {
        engineIds: ["broken"],
        response: undefined,
        outcomes: [{ engineId: "broken", ok: false, errorKind: "unknown" }],
      },
    ]);
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

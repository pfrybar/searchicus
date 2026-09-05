import { describe, expect, it } from "vitest";
import type { SearchArchive, SearchArchiveRecord } from "./archive.js";
import { AllEnginesFailedError, createDefaultRegistry, SearchEngineRegistry, UnknownEngineError } from "./registry.js";
import type { BrowserLeaseHandle, BrowserProvider, SearchContext } from "./context.js";
import type { SearchEngine, SearchQuery, SearchResponse, SearchResult, SearchSession } from "./types.js";

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

/** A browser whose page hand-out this test controls the timing of. */
function pausedBrowser(): {
  provider: BrowserProvider;
  hand: (handle: BrowserLeaseHandle) => void;
  released: string[];
} {
  const released: string[] = [];
  let hand: (handle: BrowserLeaseHandle) => void = () => undefined;
  const pending = new Promise<BrowserLeaseHandle>((resolve) => {
    hand = resolve;
  });

  return {
    released,
    hand: (handle) => hand(handle),
    provider: {
      acquire: () => pending,
      close: async () => undefined,
    },
  };
}

function leaseHandle(name: string, released: string[]): BrowserLeaseHandle {
  return {
    lease: { page: {} as never, newPage: async () => ({}) as never },
    release: async () => void released.push(name),
  };
}

describe("SearchEngineRegistry session lifetime", () => {
  it("releases a lease the session cap reached, even if the engine never finishes", async () => {
    // The regression: cleanup hung off `completed`, so an engine that never
    // settled it held its page, its slot in drain(), and close() itself open
    // forever. Aborting the signal only asks; this is the bound.
    const released: string[] = [];
    const provider: BrowserProvider = {
      acquire: async () => leaseHandle("page", released),
      close: async () => undefined,
    };

    class NeverFinishes implements SearchEngine {
      readonly id = "stuck";
      readonly name = "Never Finishes";
      async search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
        await ctx.acquireBrowser();
        return {
          response: { query, results: [], engine: this.id, tookMs: 0 },
          completed: new Promise<void>(() => undefined),
        };
      }
    }

    const registry = new SearchEngineRegistry({ throttle: null, browser: provider, sessionTimeoutMs: 40 });
    registry.register(new NeverFinishes());

    await registry.searchAll({ query: "x" }, ["stuck"]);
    expect(registry.activeSessions).toBe(1);

    // The whole point: this returns rather than hanging.
    await registry.drain();
    expect(registry.activeSessions).toBe(0);
    expect(released).toEqual(["page"]);
  });

  it("releases a lease that arrives after the run was cleaned up", async () => {
    // A Chromium launch can still be resolving when the results deadline
    // fires. The handle used to be pushed onto an already-emptied list and
    // never released, leaking a page into a browser meant to run for days.
    const { provider, hand, released } = pausedBrowser();

    class SlowToGetABrowser implements SearchEngine {
      readonly id = "slow";
      readonly name = "Slow";
      async search(query: SearchQuery, ctx: SearchContext): Promise<SearchResponse> {
        await ctx.acquireBrowser();
        return { query, results: [], engine: this.id, tookMs: 0 };
      }
    }

    const registry = new SearchEngineRegistry({ throttle: null, browser: provider, resultsTimeoutMs: 30 });
    registry.register(new SlowToGetABrowser());

    const outcomes = await registry.searchAll({ query: "x" }, ["slow"]);
    expect(outcomes[0]?.ok).toBe(false);

    // The browser finally hands over a page, long after the search gave up.
    hand(leaseHandle("late page", released));
    await afterImmediate();
    await afterImmediate();

    expect(released).toEqual(["late page"]);
  });
});

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

  it("rejects an unregistered engine id instead of reporting it as a failure", async () => {
    const archive = new RecordingArchive();
    const registry = new SearchEngineRegistry({ throttle: null, archive }).register(new TestSearchEngine());

    // Alone, a typo would otherwise fail the whole fan-out and be reported as
    // AllEnginesFailedError — indistinguishable from every backend being down.
    await expect(registry.search({ query: "cats", engines: ["nope"] })).rejects.toBeInstanceOf(UnknownEngineError);
    // Alongside a good engine it would be worse still: a silent degraded:true.
    await expect(registry.search({ query: "cats", engines: ["test", "nope"] })).rejects.toBeInstanceOf(
      UnknownEngineError,
    );

    // Nothing ran, so there is no fan-out to archive.
    await registry.drain();
    expect(archive.records).toEqual([]);
  });

  it("still reports an unregistered engine as one outcome in the raw fan-out", async () => {
    const registry = new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine());

    const outcomes = await registry.searchAll({ query: "cats" }, ["test", "nope"]);

    expect(outcomes.map((outcome) => [outcome.engineId, outcome.ok])).toEqual([
      ["test", true],
      ["nope", false],
    ]);
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

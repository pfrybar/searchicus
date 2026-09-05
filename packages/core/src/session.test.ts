import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserLeaseHandle, BrowserProvider, SearchContext } from "./context.js";
import { createDefaultRegistry, SearchEngineRegistry, SearchOverloadedError } from "./registry.js";
import { sleep } from "./throttle.js";
import type { SearchEngine, SearchQuery, SearchResponse, SearchSession } from "./types.js";

/** A BrowserProvider that counts leases without launching anything. */
class FakeBrowser implements BrowserProvider {
  acquired = 0;
  released = 0;
  closed = false;

  async acquire(): Promise<BrowserLeaseHandle> {
    this.acquired++;
    let released = false;
    return {
      lease: { page: {} as Page, newPage: async () => ({}) as Page },
      release: async () => {
        if (released) return;
        released = true;
        this.released++;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function responseFor(id: string, query: SearchQuery): SearchResponse {
  return { query, results: [], engine: id, tookMs: 0 };
}

/** Takes a browser lease and keeps it until `completed` is settled by the test. */
class SessionEngine implements SearchEngine {
  readonly name = "Session Engine";
  readonly completed = deferred();
  sawSignal: AbortSignal | undefined;

  constructor(readonly id = "session") {}

  async search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    this.sawSignal = ctx.signal;
    await ctx.acquireBrowser();
    return { response: responseFor(this.id, query), completed: this.completed.promise };
  }
}

/** Takes a lease but returns a bare response — done the moment it has results. */
class OneShotEngine implements SearchEngine {
  readonly name = "One Shot Engine";
  constructor(readonly id = "oneshot") {}

  async search(query: SearchQuery, ctx: SearchContext): Promise<SearchResponse> {
    await ctx.acquireBrowser();
    return responseFor(this.id, query);
  }
}

/** A registry with rate limiting off, so tests don't wait five seconds. */
function registry(options: { browser?: BrowserProvider; resultsTimeoutMs?: number; sessionTimeoutMs?: number } = {}) {
  return new SearchEngineRegistry({ throttle: null, ...options });
}

let unhandled: unknown[] = [];
const record = (err: unknown) => unhandled.push(err);
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", record);
});
afterEach(() => {
  process.off("unhandledRejection", record);
});

describe("two-phase sessions", () => {
  it("returns results before the session finishes", async () => {
    const browser = new FakeBrowser();
    const engine = new SessionEngine();
    const reg = registry({ browser }).register(engine);

    const outcomes = await reg.searchAll({ query: "cats" });

    expect(outcomes[0]?.ok).toBe(true);
    expect(reg.activeSessions).toBe(1);
    expect(browser.released).toBe(0);

    engine.completed.resolve();
    await reg.drain();

    expect(reg.activeSessions).toBe(0);
    expect(browser.released).toBe(1);
  });

  it("drain() waits for work that outlives the results", async () => {
    const browser = new FakeBrowser();
    const engine = new SessionEngine();
    const reg = registry({ browser }).register(engine);

    await reg.searchAll({ query: "cats" });

    let drained = false;
    const draining = reg.drain().then(() => (drained = true));

    await sleep(20);
    expect(drained).toBe(false);

    engine.completed.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it("releases the lease when a session fails late, without an unhandled rejection", async () => {
    const browser = new FakeBrowser();
    const engine = new SessionEngine();
    const reg = registry({ browser }).register(engine);

    await reg.searchAll({ query: "cats" });
    engine.completed.reject(new Error("browser died after returning results"));
    await reg.drain();

    expect(browser.released).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("releases the lease immediately for an engine that returns a bare response", async () => {
    const browser = new FakeBrowser();
    const reg = registry({ browser }).register(new OneShotEngine());

    await reg.searchAll({ query: "cats" });

    expect(browser.acquired).toBe(1);
    expect(browser.released).toBe(1);
    expect(reg.activeSessions).toBe(0);
  });

  it("releases the lease when an engine throws after taking one", async () => {
    const browser = new FakeBrowser();
    const reg = registry({ browser }).register({
      id: "boom",
      name: "Boom",
      search: async (_query: SearchQuery, ctx: SearchContext) => {
        await ctx.acquireBrowser();
        throw new Error("parse failed");
      },
    });

    const outcomes = await reg.searchAll({ query: "cats" });

    expect(outcomes[0]).toMatchObject({ ok: false, error: "parse failed" });
    expect(browser.released).toBe(1);
  });
});

describe("browser availability", () => {
  it("explains how to attach a browser when none is configured", async () => {
    const reg = registry().register(new OneShotEngine());

    const outcomes = await reg.searchAll({ query: "cats" });

    expect(outcomes[0]?.ok).toBe(false);
    if (!outcomes[0]?.ok) expect(outcomes[0]?.error).toMatch(/createBrowserRegistry/);
  });

  it("never touches the browser for an engine that doesn't ask for one", async () => {
    const browser = new FakeBrowser();
    const reg = registry({ browser }).register({
      id: "nobrowser",
      name: "No Browser",
      search: async (query: SearchQuery) => responseFor("nobrowser", query),
    });

    await reg.searchAll({ query: "cats" });

    expect(browser.acquired).toBe(0);
  });
});

describe("timeouts", () => {
  it("fails a slow engine without sinking the rest of the fan-out", async () => {
    const reg = registry({ resultsTimeoutMs: 60 })
      .register({
        id: "slow",
        name: "Slow",
        search: async (query: SearchQuery) => {
          await sleep(500);
          return responseFor("slow", query);
        },
      })
      .register({ id: "fast", name: "Fast", search: async (q: SearchQuery) => responseFor("fast", q) });

    const outcomes = await reg.searchAll({ query: "cats" }, ["slow", "fast"]);

    expect(outcomes.find((o) => o.engineId === "fast")?.ok).toBe(true);
    const slow = outcomes.find((o) => o.engineId === "slow");
    expect(slow?.ok).toBe(false);
    if (slow && !slow.ok) expect(slow.error).toMatch(/timed out/);
  });

  it("aborts the session signal once the session budget is spent", async () => {
    const browser = new FakeBrowser();
    const engine = new SessionEngine();
    const reg = registry({ browser, sessionTimeoutMs: 40 }).register(engine);

    await reg.searchAll({ query: "cats" });
    expect(engine.sawSignal?.aborted).toBe(false);

    await sleep(80);
    expect(engine.sawSignal?.aborted).toBe(true);

    engine.completed.resolve();
    await reg.drain();
  });
});

describe("rate limiting", () => {
  it("gates the whole fan-out once, not each engine", async () => {
    const reg = new SearchEngineRegistry({ throttle: { minIntervalMs: 200, jitter: 0 } })
      .register({ id: "a", name: "A", search: async (q: SearchQuery) => responseFor("a", q) })
      .register({ id: "b", name: "B", search: async (q: SearchQuery) => responseFor("b", q) });

    const start = Date.now();
    const outcomes = await reg.searchAll({ query: "cats" });

    // Two engines, one shared wait — the first fan-out isn't delayed at all.
    expect(Date.now() - start).toBeLessThan(150);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it("spaces consecutive fan-outs apart", async () => {
    const reg = new SearchEngineRegistry({ throttle: { minIntervalMs: 120, jitter: 0 } }).register({
      id: "a",
      name: "A",
      search: async (q: SearchQuery) => responseFor("a", q),
    });

    await reg.searchAll({ query: "first" });
    const start = Date.now();
    await reg.searchAll({ query: "second" });

    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("refuses rather than blaming the engines when the rate-limit wait exhausts the budget", async () => {
    // This used to report every engine as failed, which was archived, which
    // made the dashboard built to judge engines report all of them broken
    // after a burst that never reached one. Nothing here describes a backend,
    // so nothing here is reported as one.
    const reg = new SearchEngineRegistry({
      throttle: { minIntervalMs: 5_000, jitter: 0 },
      resultsTimeoutMs: 50,
    })
      .register({ id: "a", name: "A", search: async (q: SearchQuery) => responseFor("a", q) })
      .register({ id: "b", name: "B", search: async (q: SearchQuery) => responseFor("b", q) });

    await reg.searchAll({ query: "first" });

    await expect(reg.searchAll({ query: "second" })).rejects.toBeInstanceOf(SearchOverloadedError);
    expect(reg.overload).toEqual({ refused: 0, abandoned: 1 });
  });
});

describe("close()", () => {
  it("drains sessions, then closes the browser", async () => {
    const browser = new FakeBrowser();
    const engine = new SessionEngine();
    const reg = registry({ browser }).register(engine);

    await reg.searchAll({ query: "cats" });

    let closed = false;
    const closing = reg.close().then(() => (closed = true));

    await sleep(20);
    expect(closed).toBe(false);
    expect(browser.closed).toBe(false);

    engine.completed.resolve();
    await closing;

    expect(browser.released).toBe(1);
    expect(browser.closed).toBe(true);
  });

  it("refuses new searches once closed", async () => {
    const reg = registry().register(new OneShotEngine());
    await reg.close();

    const outcomes = await reg.searchAll({ query: "cats" });
    expect(outcomes[0]).toMatchObject({ ok: false });
  });
});

describe("browser-backed engines (registration and wiring)", () => {
  it("registers every engine by default, so an unfiltered search fans out to all of them", () => {
    const ids = createDefaultRegistry({ throttle: null })
      .list()
      .map((engine) => engine.id);
    expect(ids).toEqual(["bing", "brave", "duckduckgo", "startpage"]);
  });

  it.each(["bing", "brave", "duckduckgo", "startpage"])(
    "fails with a diagnosable error when %s has no browser",
    async (engineId) => {
      const outcomes = await createDefaultRegistry({ throttle: null }).searchAll({ query: "cats" }, [engineId]);

      expect(outcomes[0]?.ok).toBe(false);
      if (!outcomes[0]?.ok) expect(outcomes[0]?.error).toMatch(/createBrowserRegistry|browser session/i);
    },
  );
});

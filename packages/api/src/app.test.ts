import {
  ExtractFailedError,
  SearchEngineRegistry,
  Throttle,
  type ArchiveInsights,
  type EngineMetricsReport,
  type PageRenderer,
  type SearchSummary,
} from "@searchicus/core";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { testExtraction } from "./__fixtures__/test-extraction.js";
import { TestSearchEngine } from "./__fixtures__/test-engine.js";
import { createApp } from "./app.js";

/**
 * A registry holding only a deterministic test double. These tests exercise
 * the adapter layer, not whichever engines happen to be registered by default.
 */
function testRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine());
}

function testApp() {
  return createApp(testRegistry());
}

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await request(testApp()).get("/health");
    expect(res.status).toBe(200);
    // `extract` reports whether this deployment will actually render pages,
    // so the UI can hide an action that would otherwise only ever fail.
    expect(res.body).toEqual({ status: "ok", extract: false, insights: false });
  });
});

describe("POST /search", () => {
  it("returns one ranked response by default", async () => {
    const res = await request(testApp()).post("/search").send({ query: "cats" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ query: { query: "cats" }, degraded: false });
    expect(res.body.results).toHaveLength(8);
    expect(res.body.results[0]).toMatchObject({ title: "Test result 1", url: "https://result-1.example.test/" });
    expect(res.body).not.toHaveProperty("searchId");
    expect(res.body.results[0]).not.toHaveProperty("ref");
    expect(res.body).not.toHaveProperty("outcomes");
  });

  it("applies the requested final result limit", async () => {
    const res = await request(testApp()).post("/search").send({ query: "cats", limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it("marks partial results as degraded without revealing the failed engine", async () => {
    const registry = new SearchEngineRegistry({ throttle: null })
      .register(new TestSearchEngine())
      .register({ id: "broken", name: "Broken", search: async () => Promise.reject(new Error("blocked")) });

    const res = await request(createApp(registry)).post("/search").send({ query: "cats" });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body).not.toHaveProperty("outcomes");
    expect(JSON.stringify(res.body)).not.toContain("broken");
  });

  it("reports total engine failure without exposing backend details", async () => {
    const registry = new SearchEngineRegistry({ throttle: null }).register({
      id: "broken",
      name: "Broken",
      search: async () => Promise.reject(new Error("blocked")),
    });

    const res = await request(createApp(registry)).post("/search").send({ query: "cats" });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Search unavailable" });
  });

  it("rejects an invalid request body", async () => {
    const missingQuery = await request(testApp()).post("/search").send({});
    const invalidLimit = await request(testApp()).post("/search").send({ query: "cats", limit: 0 });
    const whitespaceQuery = await request(testApp()).post("/search").send({ query: "   " });
    const removedEngines = await request(testApp())
      .post("/search")
      .send({ query: "cats", engines: ["test"] });

    for (const res of [missingQuery, invalidLimit, whitespaceQuery, removedEngines]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid search request");
      expect(res.body.details).toBeInstanceOf(Array);
    }
  });

  it("rejects malformed JSON bodies", async () => {
    const res = await request(testApp()).post("/search").set("Content-Type", "application/json").send("{not json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    const res = await request(testApp()).get("/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /search when the rate-limit queue is full", () => {
  it("answers 503 with a Retry-After rather than the 502 that means the backends are down", async () => {
    // maxQueued 1, and one caller already holding the queue open, so the
    // request under test is refused at the door.
    const throttle = new Throttle({ minIntervalMs: 60_000, jitter: 0, maxQueued: 1 });
    await throttle.acquire();
    const holding = throttle.acquire(AbortSignal.timeout(30_000));
    void holding.catch(() => undefined);

    const app = createApp(new SearchEngineRegistry({ throttle }).register(new TestSearchEngine()));
    const res = await request(app).post("/search").send({ query: "cats" });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toEqual({ error: "Too many searches in progress. Try again shortly." });
  });
});

describe("request limits", () => {
  it("answers an oversized body with 413 rather than a 500", async () => {
    // body-parser already knew its own limit was the reason; the generic
    // handler turned that into "this server is broken" instead of "send less".
    const res = await request(testApp())
      .post("/search")
      .set("content-type", "application/json")
      .send(JSON.stringify({ query: "x".repeat(200_000) }));

    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/must not exceed/);
  });

  it("takes the body limit from configuration, and says which one it applied", async () => {
    const app = createApp(new SearchEngineRegistry(), { jsonBodyLimit: "1kb" });

    const res = await request(app)
      .post("/search")
      .set("content-type", "application/json")
      .send(JSON.stringify({ query: "x".repeat(4_000) }));

    expect(res.status).toBe(413);
    expect(String(res.body.error)).toContain("1kb");
  });

  it("bounds the fields a caller can send", async () => {
    const app = testApp();

    const longQuery = await request(app)
      .post("/search")
      .send({ query: "x".repeat(2_000) });
    expect(longQuery.status).toBe(400);

    const removedEngines = await request(app)
      .post("/search")
      .send({ query: "cats", engines: ["bing"] });
    expect(removedEngines.status).toBe(400);

    // The bound is generous: an ordinary request is nowhere near it.
    const ordinary = await request(app)
      .post("/search")
      .send({ query: "x".repeat(1_000) });
    expect(ordinary.status).toBe(200);
  });
});

describe("POST /outline", () => {
  it("returns a page's structure, addressed by the offsets extract takes", async () => {
    const res = await request(createApp(testRegistry(), { extraction: testExtraction() }))
      .post("/outline")
      .send({
        url: "https://example.com/a",
      });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("usable");
    expect(res.body.untrusted).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.sections.length).toBeGreaterThan(0);
    expect(res.body.sections[0]).toMatchObject({ offset: expect.any(Number), chars: expect.any(Number) });
    expect(res.body).not.toHaveProperty("markdown");
  });

  it("rejects a bad request and reports a disabled deployment separately", async () => {
    const app = createApp(testRegistry(), { extraction: testExtraction() });
    expect((await request(app).post("/outline").send({})).status).toBe(400);
    // A malformed URL is the caller's to fix, exactly as it is for a read.
    expect((await request(app).post("/outline").send({ url: "not a url" })).status).toBe(400);

    const off = createApp(testRegistry());
    expect((await request(off).post("/outline").send({ url: "https://example.com/" })).status).toBe(503);
  });
});

describe("POST /find", () => {
  const findApp = () => createApp(testRegistry(), { extraction: testExtraction() });

  it("returns matching sections, marked untrusted", async () => {
    const res = await request(findApp()).post("/find").send({ url: "https://example.com/a", query: "readable prose" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      query: "readable prose",
      untrusted: true,
      cached: false,
      totalChars: expect.any(Number),
      navigable: expect.any(Boolean),
    });
    expect(res.body.matches[0]).toMatchObject({
      offset: expect.any(Number),
      coverage: expect.any(Number),
      markdown: expect.stringContaining("readable prose"),
      truncated: false,
    });
  });

  it("answers a page that does not discuss the query with 200 and no matches", async () => {
    // Not a 404 and not a 502: the caller asked a question and got a true
    // answer. An error here would tell an agent to retry something that
    // will keep giving the same result.
    const res = await request(findApp()).post("/find").send({ url: "https://example.com/a", query: "kubernetes" });

    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });

  it("requires a query, and one with a word in it", async () => {
    const app = findApp();
    expect((await request(app).post("/find").send({ url: "https://example.com/a" })).status).toBe(400);
    expect((await request(app).post("/find").send({ url: "https://example.com/a", query: "  " })).status).toBe(400);

    const empty = await request(app).post("/find").send({ url: "https://example.com/a", query: "the and of" });
    expect(empty.status).toBe(400);
    expect(String(empty.body.details)).toMatch(/word to search for/);
  });

  it("reports a disabled deployment separately from a bad request", async () => {
    const off = createApp(testRegistry());
    const res = await request(off).post("/find").send({ url: "https://example.com/", query: "anything" });
    expect(res.status).toBe(503);
  });
});

describe("POST /extract", () => {
  function extractApp(renderer?: PageRenderer) {
    return createApp(testRegistry(), { extraction: testExtraction({}, renderer) });
  }

  it("returns Markdown, marked untrusted", async () => {
    const res = await request(extractApp()).post("/extract").send({ url: "https://example.test/article" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: "https://example.test/article",
      finalUrl: "https://example.test/article",
      title: "An article",
      markdown: "# An article\n\nSome readable prose.",
      truncated: false,
      chars: 34,
      cached: false,
      untrusted: true,
    });
  });

  it("answers under /api too, which is what the UI calls", async () => {
    const res = await request(extractApp()).post("/api/extract").send({ url: "https://example.test/article" });

    expect(res.status).toBe(200);
  });

  it("refuses with 503 when the operator has not enabled extraction", async () => {
    // The route still exists. A caller learns extraction is switched off,
    // rather than meeting a 404 they cannot interpret.
    const res = await request(createApp(testRegistry())).post("/extract").send({ url: "https://example.test/a" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/SEARCHICUS_EXTRACT_ENABLED/);
  });

  it("rejects a malformed body with 400", async () => {
    const app = extractApp();
    const noUrl = await request(app).post("/extract").send({});
    const blankUrl = await request(app).post("/extract").send({ url: "   " });
    const hugeBudget = await request(app).post("/extract").send({ url: "https://a.test/", maxChars: 1_000_000 });

    for (const res of [noUrl, blankUrl, hugeBudget]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid extract request");
    }
  });

  it("rejects an unusable URL with 400 and says why", async () => {
    const app = extractApp();
    const scheme = await request(app).post("/extract").send({ url: "file:///etc/passwd" });
    const port = await request(app).post("/extract").send({ url: "http://example.test:8080/" });

    expect(scheme.status).toBe(400);
    expect(String(scheme.body.details)).toMatch(/http or https/);
    expect(port.status).toBe(400);
    expect(String(port.body.details)).toMatch(/allowed port/);
  });

  it("returns a completed-but-unusable page as HTTP 200 without its body", async () => {
    const missing: PageRenderer = {
      render: async (url) => ({
        finalUrl: url,
        html: "<article>substantial hostile or error-page body</article>",
        status: 404,
        redirects: 0,
      }),
      close: async () => undefined,
    };

    const res = await request(extractApp(missing)).post("/extract").send({ url: "https://example.test/missing" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: "unusable",
      reason: "not_found",
      url: "https://example.test/missing",
      finalUrl: "https://example.test/missing",
      httpStatus: 404,
      tookMs: expect.any(Number),
      cached: false,
    });
    expect(res.body).not.toHaveProperty("markdown");
  });

  it("reports a failed render as 502 without leaking the browser's error", async () => {
    const broken: PageRenderer = {
      render: () =>
        Promise.reject(
          new ExtractFailedError("navigation_failed", "That page could not be loaded.", new Error("net::ERR_FAILED")),
        ),
      close: async () => undefined,
    };

    const res = await request(extractApp(broken)).post("/extract").send({ url: "https://example.test/article" });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "That page could not be loaded." });
    expect(JSON.stringify(res.body)).not.toContain("ERR_FAILED");
  });

  it("reports enabled extraction on the health endpoint", async () => {
    const res = await request(extractApp()).get("/health");

    expect(res.body).toEqual({ status: "ok", extract: true, insights: false });
  });
});

describe("dashboard endpoints", () => {
  const metrics: EngineMetricsReport = {
    window: 2,
    totalSearches: 2,
    since: "2026-09-04T16:00:00.000Z",
    searches: { completed: 2, failed: 0, degraded: 1 },
    extractions: {
      attempted: 3,
      completed: 2,
      unusable: 0,
      unusableReasons: [],
      failed: 1,
      failures: [{ kind: "navigation_failed", count: 1 }],
      cached: 1,
      medianTookMs: 5100,
      meanChars: 8400,
      domains: 2,
    },
    engines: [
      {
        engineId: "bing",
        searches: 2,
        succeeded: 2,
        failed: 0,
        failures: [],
        medianTookMs: 100,
        p95TookMs: 120,
        meanResultCount: 8,
        meanCoverage: 1,
        meanMatch: 0.9,
        returned: 5,
        bestSource: 3,
        soleFinder: 1,
        extracted: 2,
      },
    ],
  };
  const summary: SearchSummary = {
    searchId: "abc123",
    query: "cats",
    startedAt: "2026-09-04T16:00:00.000Z",
    status: "completed",
    degraded: false,
    tookMs: 320,
    engineIds: ["bing"],
    resultCount: 5,
    engines: [],
    extractions: 0,
  };

  function insightsApp(overrides: Partial<ArchiveInsights> = {}) {
    const insights = {
      engineMetrics: async () => metrics,
      recentSearches: async () => [summary],
      searchDetail: async (searchId: string) => (searchId === "abc123" ? { ...summary, merged: null } : undefined),
      ...overrides,
    } as unknown as ArchiveInsights;
    return createApp(testRegistry(), { insights });
  }

  it("serves per-engine metrics", async () => {
    const res = await request(insightsApp()).get("/metrics/engines");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ window: 2, totalSearches: 2 });
    expect(res.body.engines[0].engineId).toBe("bing");
  });

  it("passes a window through and ignores an unusable one", async () => {
    const windows: Array<number | undefined> = [];
    const app = insightsApp({
      engineMetrics: async (options) => {
        windows.push(options?.window);
        return metrics;
      },
    });

    await request(app).get("/metrics/engines?window=10");
    await request(app).get("/metrics/engines?window=banana");
    await request(app).get("/metrics/engines");

    // Bounds are the insights layer's job; the adapter only forwards what
    // could be a number at all.
    expect(windows).toEqual([10, undefined, undefined]);
  });

  it("lists searches and pages with a keyset cursor", async () => {
    const cursors: Array<string | undefined> = [];
    const app = insightsApp({
      recentSearches: async (options) => {
        cursors.push(options?.before);
        return [summary];
      },
    });

    const res = await request(app).get("/searches?limit=5&before=xyz789");

    expect(res.status).toBe(200);
    expect(res.body.searches).toHaveLength(1);
    expect(cursors).toEqual(["xyz789"]);
  });

  it("serves one search's detail, and 404s for one that was never archived", async () => {
    const found = await request(insightsApp()).get("/searches/abc123");
    const missing = await request(insightsApp()).get("/searches/nope");

    expect(found.status).toBe(200);
    expect(found.body.searchId).toBe("abc123");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "No such search" });
  });

  it("answers 503 when no archive is configured, rather than an empty dashboard", async () => {
    const app = createApp(testRegistry());

    for (const path of ["/metrics/engines", "/searches", "/searches/abc123"]) {
      const res = await request(app).get(path);
      // An empty response would read as "you have never searched", which is a
      // different and much more confusing statement than "archiving is off".
      expect(res.status, path).toBe(503);
      expect(res.body.error).toMatch(/no search archive/i);
    }
  });

  it("reports archive availability on the health endpoint", async () => {
    expect((await request(insightsApp()).get("/health")).body).toEqual({
      status: "ok",
      extract: false,
      insights: true,
    });
  });

  it("answers under /api too, which is what the UI calls", async () => {
    expect((await request(insightsApp()).get("/api/metrics/engines")).status).toBe(200);
    expect((await request(insightsApp()).get("/api/searches")).status).toBe(200);
  });
});

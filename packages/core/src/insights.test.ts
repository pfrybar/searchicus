import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchArchiveRecord } from "./archive.js";
import { boundedLimit, MAX_INSIGHTS_LIMIT, percentile, round } from "./insights.js";
import type { RankedResult } from "./ranking.js";
import { SqliteSearchArchive } from "./storage.js";
import type { EngineFailureKind, EngineSearchOutcome, SearchResult } from "./types.js";

const directories: string[] = [];

function archive(): SqliteSearchArchive {
  const directory = mkdtempSync(path.join(tmpdir(), "searchicus-insights-"));
  directories.push(directory);
  return new SqliteSearchArchive(path.join(directory, "searchicus.sqlite"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function result(url: string, source: string): SearchResult {
  return { title: url, url, source };
}

function ranked(ref: string, url: string, found: string[], bestSource = found[0] ?? "bing"): RankedResult {
  return {
    ref,
    title: url,
    url,
    score: 0.02,
    bestSource,
    found: found.map((engineId, index) => ({ engineId, rank: index + 1 })),
    families: [...new Set(found)],
  };
}

function ok(engineId: string, tookMs: number, results: SearchResult[]): EngineSearchOutcome {
  return {
    engineId,
    ok: true,
    tookMs,
    response: { query: { query: "cats" }, engine: engineId, tookMs, results },
  };
}

function failed(engineId: string, tookMs: number, kind: EngineFailureKind): EngineSearchOutcome {
  return { engineId, ok: false, tookMs, errorKind: kind, error: `${engineId} failed` };
}

/**
 * One archived fan-out. Coverage and match are not parameters here: the
 * archive recomputes both from the results themselves, so a test steers them
 * through the result text it supplies.
 */
function record(overrides: Partial<SearchArchiveRecord> = {}): SearchArchiveRecord {
  const query = { query: "cats" };
  const searchId = overrides.searchId ?? "search01";
  return {
    searchId,
    startedAt: "2026-09-04T16:00:00.000Z",
    query,
    engineIds: ["bing", "brave"],
    outcomes: [
      ok("bing", 100, [result("https://a.test/cats", "bing"), result("https://b.test/cats", "bing")]),
      ok("brave", 300, [result("https://a.test/cats", "brave")]),
    ],
    response: {
      searchId,
      query,
      tookMs: 320,
      degraded: false,
      results: [
        ranked(`${searchId}-1`, "https://a.test/cats", ["bing", "brave"]),
        ranked(`${searchId}-2`, "https://b.test/cats", ["bing"]),
      ],
    },
    tookMs: 320,
    ...overrides,
  };
}

describe("percentile", () => {
  it("returns an observed value rather than an interpolated one", () => {
    // These are measured request times; a p95 that really happened is more
    // use than one averaged from two that did.
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("boundedLimit", () => {
  it("falls back and caps rather than letting a caller read everything", () => {
    expect(boundedLimit(undefined, 50)).toBe(50);
    expect(boundedLimit(0, 50)).toBe(50);
    expect(boundedLimit(1.5, 50)).toBe(50);
    expect(boundedLimit(10, 50)).toBe(10);
    expect(boundedLimit(999_999, 50)).toBe(MAX_INSIGHTS_LIMIT);
  });
});

describe("round", () => {
  it("keeps averages readable in a JSON response", () => {
    expect(round(0.6666666)).toBe(0.667);
    expect(round(12)).toBe(12);
  });
});

describe("engineMetrics", () => {
  it("summarizes reliability, speed, and what each engine contributed", async () => {
    const store = archive();
    await store.archive(record());
    const metrics = await store.engineMetrics();

    expect(metrics).toMatchObject({ window: 1, totalSearches: 1, since: "2026-09-04T16:00:00.000Z" });

    const bing = metrics.engines.find((engine) => engine.engineId === "bing");
    expect(bing).toMatchObject({
      searches: 1,
      succeeded: 1,
      failed: 0,
      medianTookMs: 100,
      meanResultCount: 2,
      returned: 2,
      bestSource: 2,
      soleFinder: 1,
      extracted: 0,
    });

    const brave = metrics.engines.find((engine) => engine.engineId === "brave");
    // Credited for the result it helped surface, but not for supplying the
    // display, and not as the sole finder of anything.
    expect(brave).toMatchObject({ returned: 1, bestSource: 0, soleFinder: 0 });
    await store.close();
  });

  it("counts failures by kind and leaves averages null with nothing to average", async () => {
    const store = archive();
    await store.archive(
      record({
        outcomes: [ok("bing", 100, [result("https://a.test/cats", "bing")]), failed("brave", 50, "timeout")],
      }),
    );

    const brave = (await store.engineMetrics()).engines.find((engine) => engine.engineId === "brave");
    expect(brave).toMatchObject({
      searches: 1,
      succeeded: 0,
      failed: 1,
      failures: [{ kind: "timeout", count: 1 }],
      medianTookMs: null,
      meanResultCount: null,
      meanCoverage: null,
    });
    await store.close();
  });

  it("credits an engine when a result it found was later extracted", async () => {
    const store = archive();
    await store.archive(record());
    await store.recordExtraction({
      startedAt: "2026-09-04T16:01:00.000Z",
      requestedUrl: "https://a.test/cats",
      status: "completed",
      tookMs: 700,
    });

    const metrics = await store.engineMetrics();
    // Both engines found that result, and both helped it reach the caller who
    // chose to read it — attribution is by `found`, not by who supplied the
    // title that happened to be shown.
    expect(metrics.engines.map((engine) => [engine.engineId, engine.extracted])).toEqual(
      expect.arrayContaining([
        ["bing", 1],
        ["brave", 1],
      ]),
    );
    await store.close();
  });

  it("ignores a failed extraction, which is evidence of nothing", async () => {
    const store = archive();
    await store.archive(record());
    await store.recordExtraction({
      startedAt: "2026-09-04T16:01:00.000Z",
      requestedUrl: "https://a.test/cats",
      status: "failed",
      errorKind: "timeout",
      tookMs: 15_000,
    });

    const bing = (await store.engineMetrics()).engines.find((engine) => engine.engineId === "bing");
    expect(bing?.extracted).toBe(0);
    await store.close();
  });

  it("summarizes only the most recent window, and says how much it saw", async () => {
    const store = archive();
    for (let index = 0; index < 5; index++) {
      await store.archive(record({ searchId: `search0${index}`, startedAt: `2026-09-04T16:0${index}:00.000Z` }));
    }

    const metrics = await store.engineMetrics({ window: 2 });
    // A dashboard that slows down as history accumulates stops being opened,
    // and "how is this engine doing" is a question about the recent past.
    expect(metrics.window).toBe(2);
    expect(metrics.totalSearches).toBe(5);
    expect(metrics.since).toBe("2026-09-04T16:03:00.000Z");
    expect(metrics.engines.find((engine) => engine.engineId === "bing")?.searches).toBe(2);
    await store.close();
  });

  it("totals how the fan-outs ended, separately from what the engines did", async () => {
    const store = archive();
    await store.archive(record({ searchId: "s1", startedAt: "2026-09-04T10:00:00.000Z" }));
    await store.archive(
      record({
        searchId: "s2",
        startedAt: "2026-09-04T10:01:00.000Z",
        outcomes: [ok("bing", 100, [result("https://a.test/1", "bing")]), failed("brave", 90, "no_results")],
        response: {
          searchId: "s2",
          query: { query: "cats" },
          results: [ranked("s2-1", "https://a.test/1", ["bing"])],
          tookMs: 100,
          degraded: true,
        },
      }),
    );
    // Every engine failed: no merged response at all.
    await store.archive(
      record({
        searchId: "s3",
        startedAt: "2026-09-04T10:02:00.000Z",
        outcomes: [failed("bing", 10, "timeout"), failed("brave", 10, "timeout")],
        response: undefined,
      }),
    );

    const report = await store.engineMetrics();
    expect(report.searches).toEqual({ completed: 2, failed: 1, degraded: 1 });
    await store.close();
  });

  it("totals extractions over the same period, including ones with no search behind them", async () => {
    const store = archive();
    await store.archive(record({ searchId: "s1", startedAt: "2026-09-04T10:00:00.000Z" }));

    const base = { startedAt: "2026-09-04T10:00:30.000Z", requestedUrl: "https://a.test/1" };
    await store.recordExtraction({ ...base, status: "completed", tookMs: 400, chars: 1000, domain: "a.test" });
    await store.recordExtraction({
      ...base,
      requestedUrl: "https://b.test/2",
      status: "completed",
      tookMs: 600,
      chars: 3000,
      domain: "b.test",
    });
    // A bare-URL read, with no search to join to. Counting only extractions
    // tied to this window's searches would quietly drop these.
    await store.recordExtraction({
      ...base,
      requestedUrl: "https://c.test/3",
      status: "failed",
      errorKind: "navigation_failed",
      tookMs: 200,
      domain: "c.test",
    });

    const report = await store.engineMetrics();
    expect(report.extractions).toEqual({
      attempted: 3,
      completed: 2,
      unusable: 0,
      unusableReasons: [],
      failed: 1,
      failures: [{ kind: "navigation_failed", count: 1 }],
      // None of these were served from cache, so all of them count toward the
      // median.
      cached: 0,
      // Nearest-rank, like the engine percentiles: over [400, 600] the p50
      // is a measurement that happened, not the 500 between them.
      medianTookMs: 400,
      meanChars: 2000,
      domains: 3,
    });
    await store.close();
  });

  it("keeps cached reads out of the median that says how long a read takes", async () => {
    // A cached read is about a millisecond and a rendered one about five
    // seconds, so a median over both drifts downward as the cache warms and
    // answers neither question.
    const store = archive();
    await store.archive(record({ searchId: "s1", startedAt: "2026-09-04T10:00:00.000Z" }));

    const base = { startedAt: "2026-09-04T10:00:30.000Z", requestedUrl: "https://a.test/1", domain: "a.test" };
    await store.recordExtraction({ ...base, status: "completed", tookMs: 5000, cached: false });
    await store.recordExtraction({ ...base, status: "completed", tookMs: 5200, cached: false });
    for (const tookMs of [1, 1, 2, 2, 1]) {
      await store.recordExtraction({ ...base, status: "completed", tookMs, cached: true });
    }

    const report = await store.engineMetrics();
    expect(report.extractions.completed).toBe(7);
    expect(report.extractions.cached).toBe(5);
    // Over the two renders, not over all seven — which would have said 2ms.
    expect(report.extractions.medianTookMs).toBe(5000);
    await store.close();
  });

  it("carries this process's refusals through without inventing them from the archive", async () => {
    // Overload is deliberately never archived, so it can only arrive from a
    // caller that has a process to ask.
    const store = archive();
    await store.archive(record());

    expect((await store.engineMetrics()).overload).toBeUndefined();
    const withCounts = await store.engineMetrics({
      overload: { search: { refused: 3, abandoned: 12 }, extract: { refused: 1, abandoned: 4 } },
    });
    expect(withCounts.overload).toEqual({
      search: { refused: 3, abandoned: 12 },
      extract: { refused: 1, abandoned: 4 },
    });
    await store.close();
  });

  it("reports an empty archive without inventing anything", async () => {
    const store = archive();
    await expect(store.engineMetrics()).resolves.toEqual({
      window: 0,
      totalSearches: 0,
      since: null,
      searches: { completed: 0, failed: 0, degraded: 0 },
      // No window means no period to count extractions over, so this reports
      // nothing rather than reaching for every extraction ever made.
      extractions: {
        attempted: 0,
        completed: 0,
        unusable: 0,
        unusableReasons: [],
        failed: 0,
        failures: [],
        cached: 0,
        medianTookMs: null,
        meanChars: null,
        domains: 0,
      },
      engines: [],
    });
    await store.close();
  });
});

describe("recentSearches", () => {
  it("lists newest first with each engine's outcome, but not its whole page", async () => {
    const store = archive();
    await store.archive(record({ searchId: "older", startedAt: "2026-09-04T16:00:00.000Z" }));
    await store.archive(record({ searchId: "newer", startedAt: "2026-09-04T17:00:00.000Z" }));

    const searches = await store.recentSearches();

    expect(searches.map((search) => search.searchId)).toEqual(["newer", "older"]);
    expect(searches[0]).toMatchObject({
      query: "cats",
      status: "completed",
      degraded: false,
      resultCount: 2,
      engineIds: ["bing", "brave"],
      extractions: 0,
    });
    // A list view carries counts; the pages themselves are the detail view's
    // job, and shipping them here would make the list enormous.
    expect(searches[0]?.engines.map((engine) => engine.engineId)).toEqual(["bing", "brave"]);
    expect(searches[0]?.engines[0]?.results).toBeUndefined();
    await store.close();
  });

  it("pages with a keyset rather than an offset", async () => {
    const store = archive();
    for (let index = 0; index < 4; index++) {
      await store.archive(record({ searchId: `s${index}`, startedAt: `2026-09-04T16:0${index}:00.000Z` }));
    }

    const first = await store.recentSearches({ limit: 2 });
    const second = await store.recentSearches({ limit: 2, before: first.at(-1)!.searchId });

    // An OFFSET would repeat or skip rows as new searches land mid-read.
    expect(first.map((search) => search.searchId)).toEqual(["s3", "s2"]);
    expect(second.map((search) => search.searchId)).toEqual(["s1", "s0"]);
    await store.close();
  });

  it("reports a total failure as such, with no result count", async () => {
    const store = archive();
    await store.archive(
      record({ response: undefined, outcomes: [failed("bing", 10, "no_results"), failed("brave", 20, "off_target")] }),
    );

    const [search] = await store.recentSearches();
    expect(search).toMatchObject({ status: "failed", resultCount: null, degraded: null });
    expect(search?.engines.every((engine) => !engine.ok)).toBe(true);
    await store.close();
  });
});

describe("searchDetail", () => {
  it("returns each engine's own page alongside the ranking that shipped", async () => {
    const store = archive();
    await store.archive(record());

    const detail = await store.searchDetail("search01");

    // The question the page exists to answer: what did each engine actually
    // say, and what did the caller end up seeing?
    expect(detail?.merged?.results.map((result) => result.ref)).toEqual(["search01-1", "search01-2"]);
    expect(detail?.engines.map((engine) => [engine.engineId, engine.results.length])).toEqual([
      ["bing", 2],
      ["brave", 1],
    ]);
    expect(detail?.engines[0]?.results[0]?.url).toBe("https://a.test/cats");
    await store.close();
  });

  it("includes the diagnostic message a list view withholds", async () => {
    const store = archive();
    await store.archive(record({ outcomes: [failed("bing", 10, "off_target")] }));

    const detail = await store.searchDetail("search01");
    expect(detail?.engines[0]).toMatchObject({ ok: false, errorKind: "off_target", error: "bing failed", results: [] });
    await store.close();
  });

  it("lists the extractions made from the search", async () => {
    const store = archive();
    await store.archive(record());
    await store.recordExtraction({
      startedAt: "2026-09-04T16:01:00.000Z",
      requestedUrl: "https://b.test/cats",
      status: "completed",
      tookMs: 800,
      title: "B",
      chars: 1200,
    });

    const detail = await store.searchDetail("search01");
    expect(detail?.extractions).toBe(1);
    expect(detail?.extractionDetails[0]).toMatchObject({
      requestedUrl: "https://b.test/cats",
      status: "completed",
      title: "B",
      chars: 1200,
    });
    await store.close();
  });

  it("matches a read to the search that offered it, however the URL was written", async () => {
    const store = archive();
    await store.archive(record());
    // Ranking already treats these as one page. Correlation has to use the
    // same rule, or a caller who pasted the URL from their address bar would
    // silently go uncredited.
    await store.recordExtraction({
      startedAt: "2026-09-04T16:01:00.000Z",
      requestedUrl: "http://www.b.test/cats/?utm_source=news",
      status: "completed",
      tookMs: 800,
    });

    const detail = await store.searchDetail("search01");
    expect(detail?.extractions).toBe(1);
    await store.close();
  });

  it("matches on the URL a read landed on, not only the one it asked for", async () => {
    const store = archive();
    await store.archive(record());
    await store.recordExtraction({
      startedAt: "2026-09-04T16:01:00.000Z",
      requestedUrl: "https://shortener.test/xyz",
      finalUrl: "https://b.test/cats",
      status: "completed",
      tookMs: 800,
    });

    expect((await store.searchDetail("search01"))?.extractions).toBe(1);
    await store.close();
  });

  it("ignores a read that happened before the search that would have offered it", async () => {
    const store = archive();
    await store.archive(record({ startedAt: "2026-09-04T16:05:00.000Z" }));
    // Same URL, read five minutes earlier. Nothing about this search sent
    // anyone there, and crediting it would invent a causal link backwards.
    await store.recordExtraction({
      startedAt: "2026-09-04T16:00:00.000Z",
      requestedUrl: "https://b.test/cats",
      status: "completed",
      tookMs: 800,
    });

    expect((await store.searchDetail("search01"))?.extractions).toBe(0);
    await store.close();
  });

  it("credits the most recent search when several offered the same URL", async () => {
    const store = archive();
    await store.archive(record({ searchId: "search01", startedAt: "2026-09-04T16:00:00.000Z" }));
    await store.archive(record({ searchId: "search02", startedAt: "2026-09-04T16:02:00.000Z" }));
    await store.recordExtraction({
      startedAt: "2026-09-04T16:03:00.000Z",
      requestedUrl: "https://b.test/cats",
      status: "completed",
      tookMs: 800,
    });

    // Best-effort by construction: without a ref there is nothing that says
    // which of the two the caller was looking at, and the later one is the
    // likelier answer. Crediting both would double-count one read.
    const recent = await store.recentSearches();
    expect(recent.map((search) => [search.searchId, search.extractions])).toEqual([
      ["search02", 1],
      ["search01", 0],
    ]);
    await store.close();
  });

  it("resolves nothing for a search that was never archived", async () => {
    const store = archive();
    await expect(store.searchDetail("nope")).resolves.toBeUndefined();
    await store.close();
  });
});

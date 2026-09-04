import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessRelevance } from "../relevance.js";
import { parseDuckDuckGoResults } from "./duckduckgo.js";

const FIXTURE = readFileSync(new URL("../__fixtures__/ddg-serp.html", import.meta.url), "utf8");
/** The query the fixture was captured for. */
const FIXTURE_QUERY = "best waterpark in chicago";

/**
 * Parsing runs against markup captured from a real SERP rather than a
 * hand-written approximation.
 *
 * The capture deliberately keeps one real ad block, because on DuckDuckGo an
 * ad is a sibling of the organic results and carries the same title-link test
 * id — the only thing separating them is the `<li>`'s `data-layout`. Its
 * tracking query string is reduced to a marker, the same treatment the base64
 * image payloads get: the structure that the parser has to reason about is
 * preserved, the session's ad identifiers are not committed.
 */
async function chromiumAvailable(): Promise<Browser | undefined> {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch({ channel: "chromium" });
  } catch {
    return undefined;
  }
}

const browser = await chromiumAvailable();

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!browser)("parseDuckDuckGoResults (against a captured SERP)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage();
    await page.setContent(FIXTURE);
  });

  function results() {
    return page.locator('ol.react-results--main li[data-layout="organic"]');
  }

  it("does not return the ad sitting in the results list", async () => {
    // The assertion that matters most on this engine. The ad is an <li> in
    // the same list, and it carries the same title-link test id as a real
    // result, so selecting on the link — which works on every other engine
    // here — would return it as a search result. Only data-layout separates
    // them, and a mistake produces plausible output rather than none.
    expect(await page.locator('ol.react-results--main li[data-layout="ad"]').count()).toBe(1);
    expect(await page.locator('li[data-layout="ad"] [data-testid="result-title-a"]').count()).toBe(1);
    expect(await page.locator('[data-testid="result-title-a"]').count()).toBe(7);

    const parsed = await parseDuckDuckGoResults(results());

    expect(parsed).toHaveLength(6);
    expect(parsed.some((r) => r.url.includes("duckduckgo.com/y.js"))).toBe(false);
    expect(parsed.every((r) => r.source === "duckduckgo")).toBe(true);
  });

  it("sees every organic block the fixture contains", async () => {
    expect(await results().count()).toBe(6);
  });

  it("reads destination URLs directly, with no redirect to unwrap", async () => {
    const parsed = await parseDuckDuckGoResults(results());

    expect(parsed.map((r) => r.url)).toEqual([
      "https://chicagobound.com/best-water-parks-in-chicago",
      "http://www.thechicagotraveler.com/top-10-water-parks-in-chicago/",
      "https://www.yelp.com/search?cflt=waterparks&find_loc=Chicago%2C+IL",
      "https://mykidlist.com/water-parks-and-beaches/",
      "https://ragingwaves.com/",
      "https://www.yelp.com/search?find_desc=Waterpark&find_loc=Chicago%2C+IL+60620",
    ]);
    expect(parsed.some((r) => r.url.includes("duckduckgo.com"))).toBe(false);
  });

  it("reads titles and snippets", async () => {
    const [first] = await parseDuckDuckGoResults(results());

    expect(first?.title).toBe("The Absolute Best Water Parks in Chicago");
    expect(first?.snippet).toContain("water parks");
  });

  it("does not stall on a result that is missing an element", { timeout: 20_000 }, async () => {
    // Playwright's text and attribute readers auto-wait, so an unguarded read
    // of an absent optional field blocks for the full 30s default timeout —
    // enough on its own to exhaust the registry's whole results budget.
    const started = Date.now();
    await parseDuckDuckGoResults(results());
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("produces results the relevance gate accepts for the query they answer", async () => {
    const parsed = await parseDuckDuckGoResults(results());
    const report = assessRelevance(FIXTURE_QUERY, parsed);

    expect(report.offTarget).toBe(false);
    expect(report.missing).toEqual([]);
  });

  it("rejects the same results against a query they do not answer", async () => {
    // The shape of the degraded page: one of the query's terms is served and
    // the rest are ignored. Only "waterpark" appears in these results.
    const parsed = await parseDuckDuckGoResults(results());
    const report = assessRelevance("waterpark reykjavik iceland", parsed);

    expect(report.offTarget).toBe(true);
    expect(report.missing).toEqual(["reykjavik", "iceland"]);
  });
});

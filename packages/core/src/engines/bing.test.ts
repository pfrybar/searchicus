import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessRelevance } from "../relevance.js";
import { decodeBingUrl, parseBingResults } from "./bing.js";

const FIXTURE = readFileSync(new URL("../__fixtures__/bing-serp.html", import.meta.url), "utf8");
/** The query the fixture was captured for. */
const FIXTURE_QUERY = "best waterpark in chicago";

describe("decodeBingUrl", () => {
  /** Builds a Bing tracking redirect around an already-encoded payload. */
  function ckUrl(payload: string): string {
    return `https://www.bing.com/ck/a?!&&p=abc123&ptn=3&ver=2&hsh=4&u=${payload}&ntb=1`;
  }

  it("recovers the destination from a real captured redirect", () => {
    const href =
      "https://www.bing.com/ck/a?!&&p=3c850e18461e979c&ptn=3&ver=2&hsh=4" +
      "&u=a1aHR0cHM6Ly9jaGljYWdvYm91bmQuY29tL2Jlc3Qtd2F0ZXItcGFya3MtaW4tY2hpY2Fnbw&ntb=1";

    expect(decodeBingUrl(href)).toBe("https://chicagobound.com/best-water-parks-in-chicago");
  });

  it("decodes a payload containing base64url's - and _ characters", () => {
    const target = "https://example.com/a?x=~~~&y=???";
    const payload = `a1${Buffer.from(target, "utf8").toString("base64url")}`;

    expect(payload).toMatch(/[-_]/); // guard: this test is only meaningful if it does
    expect(decodeBingUrl(ckUrl(payload))).toBe(target);
  });

  it("leaves a direct link alone", () => {
    expect(decodeBingUrl("https://example.com/page")).toBe("https://example.com/page");
  });

  it("leaves a redirect with no u parameter alone", () => {
    const href = "https://www.bing.com/ck/a?!&&p=abc&ptn=3";
    expect(decodeBingUrl(href)).toBe(href);
  });

  it("leaves a u parameter that is not an a1 payload alone", () => {
    const href = ckUrl("b2somethingelse");
    expect(decodeBingUrl(href)).toBe(href);
  });

  it("keeps the redirect when the payload does not decode to a URL", () => {
    // A truncated or re-encoded payload is worse than the link we started with.
    const href = ckUrl(`a1${Buffer.from("not a url at all", "utf8").toString("base64url")}`);
    expect(decodeBingUrl(href)).toBe(href);
  });

  it("does not throw on input that is not a URL at all", () => {
    expect(decodeBingUrl("/relative/path")).toBe("/relative/path");
    expect(decodeBingUrl("")).toBe("");
  });
});

/**
 * Parsing runs against markup captured from a real SERP rather than a
 * hand-written approximation, so the awkward cases are the ones Bing
 * actually serves: a result with no snippet at all, and one whose heading
 * the page's own CSS hides. Both were in the very first live response.
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

describe.skipIf(!browser)("parseBingResults (against a captured SERP)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage();
    await page.setContent(FIXTURE);
  });

  function results() {
    return page.locator("#b_results li.b_algo");
  }

  it("sees every organic block the fixture contains", async () => {
    expect(await results().count()).toBe(6);
  });

  it("returns every block that is a usable result", async () => {
    const parsed = await parseBingResults(results());

    // All six are real results, including the one whose heading is hidden by
    // CSS — reading innerText instead of textContent drops that one.
    expect(parsed).toHaveLength(6);
    expect(parsed.every((r) => r.title.trim().length > 0)).toBe(true);
    expect(parsed.every((r) => r.source === "bing")).toBe(true);
  });

  it("decodes every URL out of the tracking redirect", async () => {
    const parsed = await parseBingResults(results());

    expect(parsed.map((r) => r.url)).toEqual([
      "https://chicagobound.com/best-water-parks-in-chicago",
      "http://www.thechicagotraveler.com/top-10-water-parks-in-chicago/",
      expect.stringContaining("yelp.com"),
      "https://mykidlist.com/water-parks-and-beaches/",
      "https://ragingwaves.com/",
      expect.stringContaining("yelp.com"),
    ]);
    expect(parsed.some((r) => r.url.includes("bing.com/ck/a"))).toBe(false);
  });

  it("reads titles and snippets", async () => {
    const [first] = await parseBingResults(results());

    expect(first?.title).toBe("The Absolute Best Water Parks in Chicago");
    expect(first?.snippet).toContain("water parks");
  });

  it("leaves the snippet undefined when a result has none", async () => {
    const parsed = await parseBingResults(results());
    const noSnippet = parsed.find((r) => r.url.includes("thechicagotraveler"));

    expect(noSnippet).toBeDefined();
    expect(noSnippet?.snippet).toBeUndefined();
  });

  it("recovers a result whose heading the page hides with CSS", async () => {
    // innerText returns "" for this heading, so an innerText-based parser
    // silently discards a perfectly good result.
    const parsed = await parseBingResults(results());
    const hidden = parsed.at(-1);

    expect(hidden?.title).toBe("TOP 10 BEST Water Parks in Chicago, IL - Updated 2026 - Yelp");
    expect(hidden?.url).toContain("yelp.com");
  });

  it("does not stall on a result that is missing an element", { timeout: 20_000 }, async () => {
    // Regression test with real teeth. Playwright's innerText() auto-waits,
    // so reading a snippet that isn't there used to block for the full
    // 30s default timeout before the catch ran — one missing snippet in a
    // SERP was enough to blow the registry's entire 30s results budget.
    const started = Date.now();
    await parseBingResults(results());
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("produces results the relevance gate accepts for the query they answer", async () => {
    const parsed = await parseBingResults(results());
    const report = assessRelevance(FIXTURE_QUERY, parsed);

    expect(report.offTarget).toBe(false);
    expect(report.coverage).toBe(1);
  });
});

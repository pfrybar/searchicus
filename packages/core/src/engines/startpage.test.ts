import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessRelevance } from "../relevance.js";
import { parseStartpageResults } from "./startpage.js";

const FIXTURE = readFileSync(new URL("../__fixtures__/startpage-serp.html", import.meta.url), "utf8");
/** The query the fixture was captured for. */
const FIXTURE_QUERY = "best waterpark in chicago";

/**
 * Parsing runs against markup captured from a real SERP rather than a
 * hand-written approximation.
 *
 * The capture is the "Web results" container only. Startpage's sponsored
 * blocks render outside it, and each carries a multi-kilobyte tracking payload
 * naming the session's own segment and A/B experiment — not something to
 * commit. Ad exclusion is therefore structural here rather than asserted:
 * scoping to `.w-gl` is what leaves them out, and on the live page that scope
 * contained zero ad-marked elements.
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

describe.skipIf(!browser)("parseStartpageResults (against a captured SERP)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage();
    await page.setContent(FIXTURE);
  });

  function results() {
    return page.locator(".w-gl .result");
  }

  it("sees every organic block the fixture contains", async () => {
    expect(await results().count()).toBe(6);
  });

  it("returns every block as a usable result", async () => {
    const parsed = await parseStartpageResults(results());

    expect(parsed).toHaveLength(6);
    expect(parsed.every((r) => r.title.trim().length > 0)).toBe(true);
    expect(parsed.every((r) => r.source === "startpage")).toBe(true);
  });

  it("takes the title link and not the favicon or a sitelink", async () => {
    // Every result carries five anchors, all of them to the destination or
    // into it. The site's own test id is what makes the title link
    // unambiguous without depending on document order.
    const first = results().first();

    expect(await first.locator("a").count()).toBeGreaterThan(1);
    expect(await first.locator("[data-testid='gl-title-link']").count()).toBe(1);
  });

  it("reads destination URLs directly, with no redirect to unwrap", async () => {
    const parsed = await parseStartpageResults(results());

    expect(parsed.map((r) => r.url)).toEqual([
      "https://www.reddit.com/r/LoganSquare/comments/1lkatin/best_waterpark_in_chicago/",
      "https://ragingwaves.com/",
      "https://www.greatwolf.com/illinois",
      "https://www.yelp.com/search?find_desc=Water+Parks&find_loc=Chicago%2C+IL",
      "https://www.deepriverwaterpark.com/",
      "https://www.facebook.com/groups/chicagotraveltips/posts/1622551872038660/",
    ]);
    expect(parsed.some((r) => r.url.includes("startpage.com"))).toBe(false);
  });

  it("reads titles and snippets", async () => {
    const [first] = await parseStartpageResults(results());

    expect(first?.title).toBe("Best waterpark in Chicago? : r/LoganSquare - Reddit");
    expect(first?.snippet).toContain("Hurricane Harbor");
  });

  it("does not select on the hashed class names the styling library emits", async () => {
    // Startpage's result blocks are `class="result css-o7i03b"`. The hash is
    // regenerated whenever they build, so a selector using it would break on
    // a deploy that changed nothing visible.
    expect(FIXTURE).toContain("css-");
    expect(await page.locator(".result").count()).toBe(6);
  });

  it("honours the requested limit", async () => {
    expect(await parseStartpageResults(results(), 3)).toHaveLength(3);
    expect(await parseStartpageResults(results(), 1)).toHaveLength(1);
  });

  it("does not stall on a result that is missing an element", { timeout: 20_000 }, async () => {
    // Playwright's text and attribute readers auto-wait, so an unguarded read
    // of an absent optional field blocks for the full 30s default timeout —
    // enough on its own to exhaust the registry's whole results budget.
    const started = Date.now();
    await parseStartpageResults(results());
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("produces results the relevance gate accepts for the query they answer", async () => {
    const parsed = await parseStartpageResults(results());
    const report = assessRelevance(FIXTURE_QUERY, parsed);

    expect(report.offTarget).toBe(false);
    expect(report.missing).toEqual([]);
  });

  it("rejects the same results against a query they do not answer", async () => {
    // The shape of the degraded page: one of the query's terms is served and
    // the rest are ignored. Only "waterpark" appears in these results.
    const parsed = await parseStartpageResults(results());
    const report = assessRelevance("waterpark reykjavik iceland", parsed);

    expect(report.offTarget).toBe(true);
    expect(report.missing).toEqual(["reykjavik", "iceland"]);
  });
});

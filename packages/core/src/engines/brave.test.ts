import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessRelevance } from "../relevance.js";
import { parseBraveResults } from "./brave.js";

const FIXTURE = readFileSync(new URL("../__fixtures__/brave-serp.html", import.meta.url), "utf8");
/** The query the fixture was captured for. */
const FIXTURE_QUERY = "best waterpark in chicago";

/**
 * Parsing runs against markup captured from a real SERP rather than a
 * hand-written approximation, so the awkward cases are the ones Brave
 * actually serves: organic results interleaved with a local-listings unit, a
 * "people also ask" unit and a video cluster that share their `.snippet`
 * class, and two different description layouts.
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

describe.skipIf(!browser)("parseBraveResults (against a captured SERP)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage();
    await page.setContent(FIXTURE);
  });

  function results() {
    return page.locator("#main .snippet[data-type='web']");
  }

  it("selects only the organic web results among the units sharing their class", async () => {
    // The fixture keeps the non-organic units Brave interleaved into the
    // ranking, so this is the assertion that the allowlist earns its keep:
    // every `.snippet` that is not `data-type="web"` has to be left out.
    expect(await page.locator("#main .snippet").count()).toBeGreaterThan(6);
    expect(await results().count()).toBe(6);
  });

  it("returns every block as a usable result", async () => {
    const parsed = await parseBraveResults(results());

    expect(parsed).toHaveLength(6);
    expect(parsed.every((r) => r.title.trim().length > 0)).toBe(true);
    expect(parsed.every((r) => r.source === "brave")).toBe(true);
  });

  it("takes the destination link and not the thumbnail or an inline card", async () => {
    // The first result is a discussion layout carrying nine anchors, all to
    // the same page. Matching the anchor that wraps the title is what keeps
    // this to one unambiguous link rather than a positional guess.
    const first = results().first();

    expect(await first.locator("a").count()).toBeGreaterThan(1);
    expect(await first.locator("a:has(div.title)").count()).toBe(1);
  });

  it("reads destination URLs directly, with no redirect to unwrap", async () => {
    const parsed = await parseBraveResults(results());

    expect(parsed.map((r) => r.url)).toEqual([
      "https://www.reddit.com/r/LoganSquare/comments/1lkatin/best_waterpark_in_chicago/",
      "https://ragingwaves.com/",
      "https://www.yelp.com/search?find_desc=Water+Parks&find_loc=Chicago%2C+IL",
      "https://www.reddit.com/r/AskChicago/comments/1k9xcfo/whats_your_favorite_water_park_in_the_chicagoland/",
      "https://www.tripadvisor.com/Attractions-g28934-Activities-c52-Illinois.html",
      "https://www.omeeyo.com/blog/water-parks-in-chicago/",
    ]);
    expect(parsed.some((r) => r.url.includes("search.brave.com"))).toBe(false);
  });

  it("reads a title that the page's own CSS clamps", async () => {
    // Every Brave title carries `line-clamp-1`, so innerText would return
    // whatever happened to fit the rendered width.
    const [first] = await parseBraveResults(results());

    expect(first?.title).toBe("r/LoganSquare on Reddit: Best waterpark in Chicago?");
  });

  it("reads both description layouts", async () => {
    const parsed = await parseBraveResults(results());

    // The ordinary web result's description...
    expect(parsed[2]?.snippet).toBe("What are people saying about water parks in Chicago, IL?");
    // ...and the discussion layout, which puts the quoted question there.
    expect(parsed[0]?.snippet).toContain("new to the area");
  });

  it("honours the requested limit", async () => {
    expect(await parseBraveResults(results(), 3)).toHaveLength(3);
    expect(await parseBraveResults(results(), 1)).toHaveLength(1);
  });

  it("does not stall on a result that is missing an element", { timeout: 20_000 }, async () => {
    // Playwright's text and attribute readers auto-wait, so an unguarded read
    // of an absent optional field blocks for the full 30s default timeout —
    // enough on its own to exhaust the registry's whole results budget.
    const started = Date.now();
    await parseBraveResults(results());
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("produces results the relevance gate accepts for the query they answer", async () => {
    const parsed = await parseBraveResults(results());
    const report = assessRelevance(FIXTURE_QUERY, parsed);

    expect(report.offTarget).toBe(false);
    expect(report.missing).toEqual([]);
  });

  it("rejects the same results against a query they do not answer", async () => {
    // The shape of the degraded page: one of the query's terms is served and
    // the rest are ignored. Only "waterpark" appears in these results.
    const parsed = await parseBraveResults(results());
    const report = assessRelevance("waterpark reykjavik iceland", parsed);

    expect(report.offTarget).toBe(true);
    expect(report.missing).toEqual(["reykjavik", "iceland"]);
  });
});

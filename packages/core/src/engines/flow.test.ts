import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserLease, SearchContext } from "../context.js";
import type { SearchResult } from "../types.js";
import { NoResultsError, OffTargetResultsError, SearchBoxUnavailableError } from "./errors.js";
import { type BrowserSearchSpec, runBrowserSearch } from "./flow.js";
import { readCollapsed } from "./parse.js";

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

/**
 * A miniature search engine served from a data: URL, so the shared flow can
 * be exercised against a real browser without touching anyone's site. The
 * page mimics the one behaviour that matters here: a form whose submission
 * produces a results page.
 */
function miniSite(results: readonly string[], boxSelector = "input[name='q']", linked = true): string {
  const items = results
    .map((title) =>
      linked
        ? `<li class="r"><a class="t" href="https://example.com/${encodeURIComponent(title)}">${title}</a></li>`
        : `<li class="r">${title}</li>`,
    )
    .join("");
  return (
    `data:text/html,` +
    encodeURIComponent(
      `<form onsubmit="event.preventDefault();document.getElementById('out').innerHTML=` +
        `document.getElementById('tpl').innerHTML">` +
        (boxSelector === "none"
          ? ``
          : boxSelector === "hidden-first"
            ? `<input type="hidden" name="q"><input name="q">`
            : `<input name="q">`) +
        `</form><ul id="out"></ul><template id="tpl">${items}</template>`,
    )
  );
}

/**
 * Skips the real 5-10s dwell and pins the interaction's pacing to the low end
 * of every range, for tests that are about the flow rather than the timing.
 */
const fast = { complete: async (): Promise<void> => undefined, random: () => 0 };

function spec(homepage: string, overrides: Partial<BrowserSearchSpec> = {}): BrowserSearchSpec {
  return {
    id: "mini",
    name: "Mini",
    homepage,
    linkSelector: "a.t",
    searchBox: (page: Page) => page.locator("input[name='q']"),
    results: (page: Page) => page.locator("#out li.r"),
    parse: async (results: Locator, limit: number): Promise<SearchResult[]> => {
      const out: SearchResult[] = [];
      for (let i = 0; i < Math.min(await results.count(), limit); i++) {
        const link = results.nth(i).locator("a.t");
        // Guarded like the real parsers, and for the real reason: without
        // this, reading a result block that has no link auto-waits for
        // Playwright's 30s default. Writing this parser unguarded is what
        // made the test below hang, which is a fair demonstration of the rule.
        if ((await link.count()) === 0) continue;
        out.push({
          title: await readCollapsed(link),
          url: (await link.getAttribute("href", { timeout: 2_000 })) ?? "",
          source: "mini",
        });
      }
      return out;
    },
    ...overrides,
  };
}

describe.skipIf(!browser)("runBrowserSearch", () => {
  let page: Page;
  let ctx: SearchContext;

  beforeAll(async () => {
    page = await browser!.newPage();
    const lease: BrowserLease = { page, newPage: () => browser!.newPage() };
    ctx = { acquireBrowser: async () => lease, signal: new AbortController().signal };
  });

  it("types the query, submits, parses, and returns results before the session settles", async () => {
    const site = miniSite(["Raging Waves waterpark", "Chicago waterpark guide"]);

    const session = await runBrowserSearch(spec(site), { query: "chicago waterpark" }, ctx, { random: () => 0 });

    // The two-phase contract: results are ready here, browser work is not.
    expect(session.response.engine).toBe("mini");
    expect(session.response.results.map((r) => r.title)).toEqual(["Raging Waves waterpark", "Chicago waterpark guide"]);
    expect(session.response.tookMs).toBeGreaterThan(0);
    await expect(session.completed).resolves.toBeUndefined();
  }, 30_000);

  it("honours the query's limit", async () => {
    const site = miniSite(["Chicago waterpark one", "Chicago waterpark two", "Chicago waterpark three"]);

    const session = await runBrowserSearch(spec(site), { query: "chicago waterpark", limit: 2 }, ctx, fast);

    expect(session.response.results).toHaveLength(2);
    await session.completed;
  }, 30_000);

  it("fails fast and by name when the search box has moved", async () => {
    // The regression this exists for. pressSequentially auto-waits with
    // Playwright's 30s default, so a renamed box used to mean the engine typed
    // into nothing for the whole of the registry's 30s results budget and then
    // failed with a raw Playwright timeout naming a locator. It now fails in
    // ~5s saying which engine's box is gone.
    const started = Date.now();

    await expect(runBrowserSearch(spec(miniSite(["x"], "none")), { query: "chicago" }, ctx, fast)).rejects.toThrow(
      SearchBoxUnavailableError,
    );

    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("types into the visible box when hidden inputs match the same selector", async () => {
    // A comma selector is matched in document order, not in the order its
    // alternatives are written, so `.first()` on a union is "whichever is
    // first in the DOM" rather than "the preferred one". Startpage's homepage
    // puts four `<input type="hidden" name="query">` ahead of its real `#q`,
    // and typing into a hidden input can never work — it failed live with a
    // search box that was plainly right there.
    const site = miniSite(["Chicago waterpark guide"], "hidden-first");

    const session = await runBrowserSearch(spec(site), { query: "chicago waterpark" }, ctx, fast);

    expect(session.response.results).toHaveLength(1);
    await session.completed;
  }, 30_000);

  it("reports no results when the page renders result blocks it cannot read", async () => {
    // Result elements appear, so the wait succeeds and the parser is what
    // comes up empty. The other route to this error — no result element ever
    // attaching, which is what a consent wall or a challenge page looks like
    // — is deliberately not exercised here: it costs the full 10s results
    // timeout and raises the same error from the same function.
    const site = miniSite(["Chicago waterpark"], "input[name='q']", false);

    await expect(runBrowserSearch(spec(site), { query: "chicago waterpark" }, ctx, fast)).rejects.toThrow(
      NoResultsError,
    );
  }, 30_000);

  it("rejects results that answer a different question", async () => {
    // The degraded-serving failure: a valid, parseable page whose results are
    // real and about something else entirely.
    const site = miniSite(["Best Buy", "Best Western", "Best of the year"]);

    await expect(runBrowserSearch(spec(site), { query: "waterpark reykjavik iceland" }, ctx, fast)).rejects.toThrow(
      OffTargetResultsError,
    );
  }, 30_000);
});

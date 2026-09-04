import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import { clickThroughResult } from "../browser/click-through.js";
import { searchDwell } from "../browser/dwell.js";
import { humanPause, humanType } from "../browser/human.js";
import { assessRelevance } from "../relevance.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { NoResultsError, OffTargetResultsError } from "./errors.js";

/**
 * DuckDuckGo, driven through a real browser the way a person would drive it.
 *
 * Like Startpage, this is largely someone else's index: DuckDuckGo serves
 * mostly Bing's results with its own crawl mixed in, so it overlaps the `bing`
 * engine by design. The page says so itself — its ad links carry
 * `ad_provider=bingv7aa`. What it adds is DuckDuckGo's own ranking and the
 * portion of the corpus it crawls itself.
 *
 * Same interaction as the other engines — homepage first, type, submit, parse,
 * check relevance, then dwell and occasionally click through as
 * `SearchSession.completed`. See bing.ts for why the shape is that way; below
 * is only what DuckDuckGo does differently.
 *
 * - **Ads are siblings of the organic results, and look identical.** They are
 *   `<li>` elements in the same `ol.react-results--main` list, and each one
 *   carries the same `[data-testid="result-title-a"]` link an organic result
 *   does. Nothing about a result's own markup says whether it was paid for —
 *   only the parent `<li>`'s `data-layout` does. Selecting on the title link,
 *   which is the obvious thing to do and works on every other engine here,
 *   would return ads as search results. This is the one place in this codebase
 *   where getting the selector subtly wrong produces plausible output rather
 *   than none, so the `data-layout="organic"` filter is load-bearing and the
 *   fixture keeps a real ad block to prove it holds.
 * - **The search box is a `textarea` with no id.** Its only stable handle is
 *   `[name="q"]`; the class is a CSS-module hash.
 * - **Organic links are direct, ad links are not.** Organic results href
 *   straight to the destination, while ads route through
 *   `duckduckgo.com/y.js`. Selecting organic-only is therefore also what keeps
 *   redirect URLs out of the results, without needing a decoder.
 */

/** Where the session starts. The SERP is reached by submitting the form. */
const HOMEPAGE = "https://duckduckgo.com/";

/**
 * Organic results, in page order.
 *
 * `data-layout` is the whole of the distinction between an organic result and
 * a paid one — see the note above. The `ol` scope guards ordering, so a
 * result rendered elsewhere on the page cannot be spliced into the ranking.
 */
const RESULT_SELECTOR = 'ol.react-results--main li[data-layout="organic"]';

/** A result's title and destination link, by DuckDuckGo's own test id. */
const LINK_SELECTOR = '[data-testid="result-title-a"]';

/** The result description. */
const SNIPPET_SELECTOR = '[data-result="snippet"]';

/** Shorter than the registry's 30s results budget, so failures are specific. */
const NAVIGATION_TIMEOUT_MS = 15_000;
/** How long to wait for a results page after submitting the query. */
const RESULTS_TIMEOUT_MS = 10_000;
/**
 * Per-field read budget once the SERP is loaded. Nothing here should ever
 * wait — the page is already rendered — so this only bounds a pathological
 * case rather than being part of normal operation.
 */
const EXTRACT_TIMEOUT_MS = 2_000;

/** Default result count, matching one DuckDuckGo page. */
const DEFAULT_LIMIT = 10;

export class DuckDuckGoSearchEngine implements SearchEngine {
  readonly id = "duckduckgo";
  readonly name = "DuckDuckGo";

  async search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    // Timed from here so tookMs covers acquiring the browser and the whole
    // interaction, which is the number worth knowing.
    const start = Date.now();
    const limit = query.limit ?? DEFAULT_LIMIT;

    const { page } = await ctx.acquireBrowser();

    await page.goto(HOMEPAGE, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

    const box = searchBox(page);
    // Read the page before starting to type, as a person would.
    await humanPause(400, 1200, ctx.signal);
    await humanType(box, query.query, ctx.signal);
    await humanPause(400, 1000, ctx.signal);
    await box.press("Enter");

    const results = page.locator(RESULT_SELECTOR);
    try {
      await results.first().waitFor({ state: "attached", timeout: RESULTS_TIMEOUT_MS });
    } catch (err) {
      throw new NoResultsError(this.name, page.url(), err);
    }

    const parsed = await parseDuckDuckGoResults(results, limit);
    if (parsed.length === 0) throw new NoResultsError(this.name, page.url());

    const report = assessRelevance(query.query, parsed);
    if (report.offTarget) throw new OffTargetResultsError(this.name, query.query, report);

    return {
      response: {
        query,
        results: parsed,
        engine: this.id,
        tookMs: Date.now() - start,
      },
      // Results are ready; the page is dwelled on and then occasionally
      // clicked through in the background. The registry holds the browser
      // lease until this settles; both phases are best-effort and never reject.
      completed: completeSearchSession(page, results, ctx.signal),
    };
  }
}

/** Finishes the background browser behavior after results have been returned. */
async function completeSearchSession(page: Page, results: Locator, signal: AbortSignal): Promise<void> {
  await searchDwell(page, results, signal);
  await clickThroughResult(page, results, signal, { linkSelector: LINK_SELECTOR });
}

/**
 * The search box.
 *
 * A `textarea`, not an input, and it carries no id — the class is a CSS-module
 * hash, so `[name="q"]` is the only durable handle. The input fallback is
 * listed for the day they change the element back. Resolved once and reused,
 * rather than re-queried per keystroke.
 */
function searchBox(page: Page): Locator {
  return page.locator("textarea[name='q'], input[name='q']").first();
}

/**
 * Reads up to `limit` organic results out of an already-loaded SERP.
 *
 * The same two rules as the other parsers apply, for the same reasons: every
 * read is guarded by `count()` first, because Playwright's text and attribute
 * readers *auto-wait* and would otherwise spend the full 30s default timeout
 * discovering that an optional field is absent; and text comes from
 * `textContent` rather than `innerText`, so a title the page's own CSS clips
 * still yields its full text.
 */
export async function parseDuckDuckGoResults(results: Locator, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available && parsed.length < limit; i++) {
    const item = results.nth(i);

    const link = item.locator(LINK_SELECTOR).first();
    // An organic block with no title link is a layout variant, not a result
    // we can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      link.textContent({ timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
    ]);

    const title = collapse(rawTitle);
    // Organic links are direct, so this is a plain sanity check rather than
    // the guard against a half-decoded redirect that Bing's parser needs.
    if (!href?.startsWith("http") || !title) continue;

    const snippetEl = item.locator(SNIPPET_SELECTOR).first();
    const snippet =
      (await snippetEl.count()) > 0
        ? collapse(await snippetEl.textContent({ timeout: EXTRACT_TIMEOUT_MS }).catch(() => null))
        : "";

    parsed.push({
      title,
      url: href,
      snippet: snippet || undefined,
      source: "duckduckgo",
    });
  }

  return parsed;
}

/** Collapses runs of whitespace, since textContent preserves the markup's. */
function collapse(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

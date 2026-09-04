import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import { clickThroughResult } from "../browser/click-through.js";
import { searchDwell } from "../browser/dwell.js";
import { humanPause, humanType } from "../browser/human.js";
import { assessRelevance } from "../relevance.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { NoResultsError, OffTargetResultsError } from "./errors.js";

/**
 * Brave Search, driven through a real browser the way a person would drive it.
 *
 * The interaction is the same shape as the Bing engine — homepage first, type
 * the query, submit the form, parse, check relevance, then dwell and
 * occasionally click through as `SearchSession.completed`. See bing.ts for why
 * each of those steps is there; what follows is only what Brave does
 * differently.
 *
 * - **Results are selected by an allowlist, not by exclusion.** Brave renders
 *   its AI summary, "people also ask", local listings, video clusters,
 *   discussions and ads all as `div.snippet`, distinguished only by a
 *   `data-type` attribute or an id. Naming `data-type="web"` positively is the
 *   only definition that stays correct when Brave adds a new unit type, which
 *   it does often. A blocklist would silently start returning the new one.
 * - **The class attribute is mostly unusable.** Brave's UI is compiled from
 *   Svelte and every styled element carries a build hash — `svelte-jmfu5f`,
 *   `svelte-1rq4ngz`. Those change whenever Brave ships CSS, so nothing here
 *   may select on them. `data-type`, ids and the semantic class fragments
 *   (`title`, `generic-snippet`) are what is left, and are what this uses.
 * - **Result links are not wrapped in a redirect.** Bing hands back a
 *   `/ck/a?u=…` tracking URL that has to be decoded; Brave's anchor points
 *   straight at the destination, which is consistent with the product's
 *   privacy claims. There is deliberately no `decodeBraveUrl` counterpart —
 *   if one ever becomes necessary, the URLs will have changed shape and the
 *   fixture will show it.
 */

/** Where the session starts. The SERP URL is built by submitting the form. */
const HOMEPAGE = "https://search.brave.com/";

/**
 * Organic web results, in page order.
 *
 * Scoped to `#main` so a `data-type="web"` block rendered into the sidebar
 * could not be spliced into the middle of the ranking.
 */
const RESULT_SELECTOR = "#main .snippet[data-type='web']";

/**
 * A result's destination link.
 *
 * Matched by the title it contains rather than by position, because a result
 * block holds several anchors to the same destination — a thumbnail, and for
 * discussion results a set of inline question cards. Only the header anchor
 * wraps the title, so `:has()` picks it out without depending on ordering.
 */
const LINK_SELECTOR = "a:has(div.title)";

/** The title text inside that link. */
const TITLE_SELECTOR = "div.title";

/**
 * Description candidates. `generic-snippet` is the ordinary web result;
 * `inline-qa-question` is the forum/discussion layout, which puts the quoted
 * question where the description would otherwise be.
 */
const SNIPPET_SELECTOR = ".generic-snippet .content, .inline-qa-question";

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

/** Default result count. Brave serves about twenty per page. */
const DEFAULT_LIMIT = 10;

export class BraveSearchEngine implements SearchEngine {
  readonly id = "brave";
  readonly name = "Brave";

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

    const parsed = await parseBraveResults(results, limit);
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
 * Prefers the stable `#searchbox` id, with the form-field fallbacks that would
 * survive a rename. It is a `textarea`, not an `input`, which is why the
 * fallback list names both. Resolved once and reused, rather than re-queried
 * per keystroke.
 */
function searchBox(page: Page): Locator {
  return page.locator("#searchbox, textarea[name='q'], input[name='q']").first();
}

/**
 * Reads up to `limit` organic results out of an already-loaded SERP.
 *
 * The same two rules as the Bing parser apply, for the same reasons: every
 * read is guarded by `count()` first, because Playwright's text and attribute
 * readers *auto-wait* and would otherwise spend the full 30s default timeout
 * discovering that an optional field is absent; and text comes from
 * `textContent` rather than `innerText`, so a result whose title is clipped by
 * CSS still yields its full text. Brave makes the second point plainly — every
 * result title carries `line-clamp-1`.
 */
export async function parseBraveResults(results: Locator, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available && parsed.length < limit; i++) {
    const item = results.nth(i);

    const link = item.locator(LINK_SELECTOR).first();
    // A web block with no titled link is a layout variant, not a result we
    // can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      link
        .locator(TITLE_SELECTOR)
        .first()
        .textContent({ timeout: EXTRACT_TIMEOUT_MS })
        .catch(() => null),
    ]);

    const title = collapse(rawTitle);
    // Brave links direct, so this is a plain sanity check rather than the
    // guard against a half-decoded redirect that Bing's parser needs.
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
      source: "brave",
    });
  }

  return parsed;
}

/** Collapses runs of whitespace, since textContent preserves the markup's. */
function collapse(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import { clickThroughResult } from "../browser/click-through.js";
import { searchDwell } from "../browser/dwell.js";
import { humanPause, humanType } from "../browser/human.js";
import { assessRelevance, type RelevanceReport } from "../relevance.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";

/**
 * Bing, driven through a real browser the way a person would drive it.
 *
 * The shape of the interaction is deliberate and is the point of the engine:
 *
 * - **Homepage first, then typing.** Navigating straight to `/search?q=...`
 *   is one request with no referer and no interaction history. Loading the
 *   homepage, focusing the box and typing produces both, and costs one extra
 *   page load. The URL is never constructed at all — the form builds it.
 * - **The dwell and optional click-through run after parsing, not before.**
 *   They are handed back as `SearchSession.completed`, so the caller has
 *   results while the page is still being read and occasionally clicked.
 *   Awaiting them first would add their full delay to every search before any
 *   output appeared.
 * - **Results are checked for relevance before they are believed.** See
 *   relevance.ts: Bing sometimes answers a multi-word query with results for
 *   only its first term, and that arrives as a valid, parseable, entirely
 *   wrong page.
 */

/** Where the session starts. The SERP URL is built by submitting the form. */
const HOMEPAGE = "https://www.bing.com/";

/** Organic results. Ads are `li.b_ad` and are excluded by this selector. */
const RESULT_SELECTOR = "#b_results li.b_algo";

/**
 * Snippet candidates, most specific first. Bing rotates the clamp class by
 * layout, so the bare `p` is the last-resort fallback.
 */
const SNIPPET_SELECTOR = "p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, .b_caption p, p";

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

/** Default result count, matching one Bing page. */
const DEFAULT_LIMIT = 10;

/** Raised when Bing answers, but the answer is not about the query. */
export class OffTargetResultsError extends Error {
  constructor(
    readonly query: string,
    readonly report: RelevanceReport,
  ) {
    super(
      `Bing returned results that do not match "${query}" ` +
        `(coverage ${report.coverage.toFixed(2)}, missing: ${report.missing.join(", ")}). ` +
        `This is the degraded-serving failure, not a parse error: the page was valid and the ` +
        `results were real, they were simply answers to a different question.`,
    );
    this.name = "OffTargetResultsError";
  }
}

/** Raised when the results page never appeared, or held no organic results. */
export class NoResultsError extends Error {
  constructor(url: string, cause?: unknown) {
    super(
      `Bing returned no organic results (at ${url}). Either the query genuinely has none, ` +
        `or the page is a consent wall or an anomaly challenge rather than a SERP.`,
    );
    this.name = "NoResultsError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class BingSearchEngine implements SearchEngine {
  readonly id = "bing";
  readonly name = "Bing";

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
      throw new NoResultsError(page.url(), err);
    }

    const parsed = await parseResults(results, limit);
    if (parsed.length === 0) throw new NoResultsError(page.url());

    const report = assessRelevance(query.query, parsed);
    if (report.offTarget) throw new OffTargetResultsError(query.query, report);

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
  await clickThroughResult(page, results, signal);
}

/**
 * The search box.
 *
 * Prefers the stable `#sb_form_q` id over the accessible name. Matching by
 * role and name — `getByRole('combobox', { name: 'Enter your search here -' })`
 * — reads better but binds to a localized, A/B-tested string that Bing owns
 * and can change without notice. Resolved once and reused, rather than
 * re-queried per keystroke.
 */
function searchBox(page: Page): Locator {
  return page.locator("#sb_form_q, textarea[name='q'], input[name='q']").first();
}

/**
 * Reads up to `limit` organic results out of an already-loaded SERP.
 *
 * Every read is guarded by `count()` first. Playwright's text and attribute
 * readers *auto-wait* for their element, so calling one on a result that
 * happens to lack it blocks for the full default timeout (30s) before the
 * `catch` ever runs — and real SERPs routinely contain a `b_algo` block with
 * no snippet. `count()` resolves immediately and never waits, which turns
 * "this element isn't here" back into the cheap answer it should be. The
 * explicit timeouts below are a second line of defence for an element that
 * exists but is somehow not readable.
 *
 * Text comes from `textContent`, not `innerText`. `innerText` is what a
 * *reader* sees, so it is a function of CSS: on a real SERP one organic
 * result had its heading hidden by a style rule, and `innerText` returned an
 * empty string for a perfectly good Yelp listing, which this parser then
 * discarded as a non-result. `textContent` reads the DOM instead of the
 * render, so it does not depend on styling, viewport, fonts, or how the
 * headless renderer happens to lay the page out. Whitespace is normalized by
 * hand since `textContent` does not collapse it.
 */
export async function parseResults(results: Locator, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available && parsed.length < limit; i++) {
    const item = results.nth(i);

    const link = item.locator("h2 a").first();
    // A b_algo block with no linked heading is a layout variant (video
    // carousels, "people also ask"), not a result we can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      link.textContent({ timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
    ]);

    const title = collapse(rawTitle);
    if (!href?.startsWith("http") || !title) continue;

    const snippetEl = item.locator(SNIPPET_SELECTOR).first();
    const snippet =
      (await snippetEl.count()) > 0
        ? collapse(await snippetEl.textContent({ timeout: EXTRACT_TIMEOUT_MS }).catch(() => null))
        : "";

    parsed.push({
      title,
      url: decodeBingUrl(href),
      snippet: snippet || undefined,
      source: "bing",
    });
  }

  return parsed;
}

/** Collapses runs of whitespace, since textContent preserves the markup's. */
function collapse(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Recovers the real destination from Bing's `/ck/a?u=a1<payload>` tracking
 * redirect, leaving any other URL alone.
 *
 * The payload is **base64url**, and this decodes it as such. Note that Node
 * would in fact get this right either way — its `"base64"` decoder accepts
 * the base64url alphabet, so `-` and `_` round-trip correctly even when the
 * encoding is named wrong. `"base64url"` is used here because it states the
 * actual wire format rather than relying on that leniency, which is not
 * shared by every base64 implementation a port might move to.
 */
export function decodeBingUrl(href: string): string {
  try {
    const encoded = new URL(href).searchParams.get("u");
    if (!encoded?.startsWith("a1") || encoded.length <= 2) return href;

    const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    // A truncated or non-URL payload is worse than the redirect we started
    // with; only take the decoded value if it is actually a URL.
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch {
    // Not a parseable URL: hand back exactly what Bing gave us.
    return href;
  }
}

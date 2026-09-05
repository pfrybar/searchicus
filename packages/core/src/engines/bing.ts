import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { type BrowserSearchSpec, runBrowserSearch } from "./flow.js";
import { collapse, EXTRACT_TIMEOUT_MS, isWebUrl, readCollapsed, readSnippet } from "./parse.js";

/**
 * Bing, driven through a real browser the way a person would drive it.
 *
 * See flow.ts for the interaction every engine performs and why. What is
 * specific to Bing:
 *
 * - **Result links are wrapped in a tracking redirect.** Bing hands back a
 *   `/ck/a?u=a1<payload>` URL rather than the destination, so this is the one
 *   engine here that needs a decoder — see {@link decodeBingUrl}.
 * - **Ads are excluded by the result selector itself.** They are `li.b_ad`,
 *   so selecting `li.b_algo` leaves them out without a second filter.
 */

/** Where the session starts. The SERP URL is built by submitting the form. */
const HOMEPAGE = "https://www.bing.com/";

/** Organic results. Ads are `li.b_ad` and are excluded by this selector. */
const RESULT_SELECTOR = "#b_results li.b_algo";

/** A result's destination link, shared by the parser and the click-through. */
const LINK_SELECTOR = "h2 a";

/**
 * Snippet candidates, most specific first. Bing rotates the clamp class by
 * layout, so the bare `p` is the last-resort fallback.
 */
const SNIPPET_SELECTOR = "p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, .b_caption p, p";

export class BingSearchEngine implements SearchEngine, BrowserSearchSpec {
  readonly id = "bing";
  readonly name = "Bing";
  readonly indexFamily = "bing";
  readonly homepage = HOMEPAGE;
  readonly linkSelector = LINK_SELECTOR;

  /**
   * The search box.
   *
   * Prefers the stable `#sb_form_q` id over the accessible name. Matching by
   * role and name — `getByRole('combobox', { name: 'Enter your search here -' })`
   * — reads better but binds to a localized, A/B-tested string that Bing owns
   * and can change without notice.
   */
  searchBox(page: Page): Locator {
    return page.locator("#sb_form_q, textarea[name='q'], input[name='q']");
  }

  results(page: Page): Locator {
    return page.locator(RESULT_SELECTOR);
  }

  parse(results: Locator): Promise<SearchResult[]> {
    return parseBingResults(results);
  }

  search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    return runBrowserSearch(this, query, ctx);
  }
}

/** Reads every eligible organic result out of an already-loaded SERP. */
export async function parseBingResults(results: Locator): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available; i++) {
    const item = results.nth(i);

    const link = item.locator(LINK_SELECTOR).first();
    // A b_algo block with no linked heading is a layout variant (video
    // carousels, "people also ask"), not a result we can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      readCollapsed(link),
    ]);

    const title = collapse(rawTitle);
    if (!isWebUrl(href) || !title) continue;

    parsed.push({
      title,
      url: decodeBingUrl(href),
      snippet: await readSnippet(item.locator(SNIPPET_SELECTOR).first()),
      source: "bing",
    });
  }

  return parsed;
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

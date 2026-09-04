import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { type BrowserSearchSpec, runBrowserSearch } from "./flow.js";
import { DEFAULT_LIMIT, EXTRACT_TIMEOUT_MS, collapse, readCollapsed, readSnippet } from "./parse.js";

/**
 * DuckDuckGo, driven through a real browser the way a person would drive it.
 *
 * Like Startpage, this is largely someone else's index: DuckDuckGo serves
 * mostly Bing's results with its own crawl mixed in, so it overlaps the `bing`
 * engine by design. The page says so itself — its ad links carry
 * `ad_provider=bingv7aa`. What it adds is DuckDuckGo's own ranking and the
 * portion of the corpus it crawls itself.
 *
 * See flow.ts for the interaction every engine performs and why. What is
 * specific to DuckDuckGo:
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

export class DuckDuckGoSearchEngine implements SearchEngine, BrowserSearchSpec {
  readonly id = "duckduckgo";
  readonly name = "DuckDuckGo";
  readonly homepage = HOMEPAGE;
  readonly linkSelector = LINK_SELECTOR;

  /**
   * The search box. A `textarea`, not an input, and it carries no id — the
   * class is a CSS-module hash, so `[name="q"]` is the only durable handle.
   * The input fallback is listed for the day they change the element back.
   */
  searchBox(page: Page): Locator {
    return page.locator("textarea[name='q'], input[name='q']");
  }

  results(page: Page): Locator {
    return page.locator(RESULT_SELECTOR);
  }

  parse(results: Locator, limit: number): Promise<SearchResult[]> {
    return parseDuckDuckGoResults(results, limit);
  }

  search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    return runBrowserSearch(this, query, ctx);
  }
}

/** Reads up to `limit` organic results out of an already-loaded SERP. */
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
      readCollapsed(link),
    ]);

    const title = collapse(rawTitle);
    // Organic links are direct, so this is a plain sanity check rather than
    // the guard against a half-decoded redirect that Bing's parser needs.
    if (!href?.startsWith("http") || !title) continue;

    parsed.push({
      title,
      url: href,
      snippet: await readSnippet(item.locator(SNIPPET_SELECTOR).first()),
      source: "duckduckgo",
    });
  }

  return parsed;
}

import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { type BrowserSearchSpec, runBrowserSearch } from "./flow.js";
import { EXTRACT_TIMEOUT_MS, collapse, readCollapsed, readSnippet } from "./parse.js";

/**
 * Brave Search, driven through a real browser the way a person would drive it.
 *
 * See flow.ts for the interaction every engine performs and why. What is
 * specific to Brave:
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
 * - **Result links are not wrapped in a redirect.** Brave's anchor points
 *   straight at the destination, which is consistent with the product's
 *   privacy claims, so there is deliberately no `decodeBraveUrl` counterpart
 *   to Bing's decoder.
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

export class BraveSearchEngine implements SearchEngine, BrowserSearchSpec {
  readonly id = "brave";
  readonly name = "Brave";
  readonly homepage = HOMEPAGE;
  readonly linkSelector = LINK_SELECTOR;

  /**
   * The search box. It is a `textarea`, not an `input`, which is why the
   * fallback list names both.
   */
  searchBox(page: Page): Locator {
    return page.locator("#searchbox, textarea[name='q'], input[name='q']");
  }

  results(page: Page): Locator {
    return page.locator(RESULT_SELECTOR);
  }

  parse(results: Locator): Promise<SearchResult[]> {
    return parseBraveResults(results);
  }

  search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    return runBrowserSearch(this, query, ctx);
  }
}

/** Reads every eligible organic result out of an already-loaded SERP. */
export async function parseBraveResults(results: Locator): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available; i++) {
    const item = results.nth(i);

    const link = item.locator(LINK_SELECTOR).first();
    // A web block with no titled link is a layout variant, not a result we
    // can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      readCollapsed(link.locator(TITLE_SELECTOR).first()),
    ]);

    const title = collapse(rawTitle);
    // Brave links direct, so this is a plain sanity check rather than the
    // guard against a half-decoded redirect that Bing's parser needs.
    if (!href?.startsWith("http") || !title) continue;

    parsed.push({
      title,
      url: href,
      snippet: await readSnippet(item.locator(SNIPPET_SELECTOR).first()),
      source: "brave",
    });
  }

  return parsed;
}

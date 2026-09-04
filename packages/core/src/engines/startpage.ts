import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { type BrowserSearchSpec, runBrowserSearch } from "./flow.js";
import { EXTRACT_TIMEOUT_MS, collapse, readCollapsed, readSnippet } from "./parse.js";

/**
 * Startpage, driven through a real browser the way a person would drive it.
 *
 * Startpage is a proxy rather than an index of its own: it serves mostly
 * Google's results with some of Bing's mixed in. Running it alongside the
 * `bing` engine therefore returns overlapping results by design — what it adds
 * is Google's ranking, which nothing else here reaches.
 *
 * See flow.ts for the interaction every engine performs and why. What is
 * specific to Startpage:
 *
 * - **The results page is a POST.** Submitting the form lands on
 *   `/sp/search` with no query string at all; the query and the form's hidden
 *   fields go in the body. For the other engines, driving the homepage instead
 *   of building a `?q=` URL is a choice about looking ordinary. Here there is
 *   no URL to build, so it is the only way in — and `page.url()` on the SERP
 *   does not name the query, which is worth knowing when reading an error.
 * - **The search input is `name="query"`, not `name="q"`.** The id is `#q`,
 *   which makes the obvious `input[name='q']` fallback wrong in a way that
 *   would only show up once the id changed.
 * - **Ads sit outside the results container.** Everything under the "Web
 *   results" `.w-gl` block is organic, and the sponsored units are elsewhere
 *   in the page, so scoping to that container excludes them structurally
 *   rather than by recognising them.
 * - **`data-testid` is the stable handle; the class attribute is not.**
 *   Startpage styles with a CSS-in-JS library that emits hashed class names
 *   (`css-o7i03b`, `css-4wnopv`) regenerated on each build — the same trap as
 *   Brave's Svelte hashes. The test ids are the site's own, and are what this
 *   selects on wherever one exists.
 * - **This is the site that made `readText()` necessary.** Its styling
 *   library parks each `<style>` next to its own component during hydration,
 *   so titles read soon enough after load arrive with CSS in them. See
 *   parse.ts; every engine now reads text that way.
 * - **Every result link opens a new tab.** Unlike Bing and Brave, which
 *   navigate in place, Startpage marks its result anchors `target="_blank"`,
 *   so a click-through here reliably produces a popup. That page is outside
 *   the browser lease, which is why `clickThroughResult` owns and closes it.
 */

/** Where the session starts. The SERP is reached by submitting the form. */
const HOMEPAGE = "https://www.startpage.com/";

/**
 * Organic results, scoped to the "Web results" container.
 *
 * The scope is what keeps ads out: sponsored blocks are rendered outside
 * `.w-gl` entirely, so there is nothing to detect and no ad-marker class to
 * keep up with.
 */
const RESULT_SELECTOR = ".w-gl .result";

/** A result's title and destination link, by Startpage's own test id. */
const LINK_SELECTOR = "[data-testid='gl-title-link']";

/** The result description. No test id on this one, but the class is semantic. */
const SNIPPET_SELECTOR = "p.description";

export class StartpageSearchEngine implements SearchEngine, BrowserSearchSpec {
  readonly id = "startpage";
  readonly name = "Startpage";
  readonly indexFamily = "google";
  readonly homepage = HOMEPAGE;
  readonly linkSelector = LINK_SELECTOR;

  /**
   * The search box. `#q` is the id; the field's name is `query`, so the usual
   * `[name='q']` fallback would not find it and is deliberately not listed.
   *
   * This union matches five elements on the live homepage, four of them
   * `<input type="hidden" name="query">` that sit *earlier* in the document
   * than `#q`. Narrowing with `.first()` here would therefore pick a hidden
   * input and type into nothing; the flow filters to visible first.
   */
  searchBox(page: Page): Locator {
    return page.locator("#q, input[name='query']");
  }

  results(page: Page): Locator {
    return page.locator(RESULT_SELECTOR);
  }

  parse(results: Locator): Promise<SearchResult[]> {
    return parseStartpageResults(results);
  }

  search(query: SearchQuery, ctx: SearchContext): Promise<SearchSession> {
    return runBrowserSearch(this, query, ctx);
  }
}

/** Reads every eligible organic result out of an already-loaded SERP. */
export async function parseStartpageResults(results: Locator): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available; i++) {
    const item = results.nth(i);

    const link = item.locator(LINK_SELECTOR).first();
    // A result block with no title link is a layout variant, not a result we
    // can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      readCollapsed(link),
    ]);

    const title = collapse(rawTitle);
    // Startpage links direct, so this is a plain sanity check rather than the
    // guard against a half-decoded redirect that Bing's parser needs.
    if (!href?.startsWith("http") || !title) continue;

    parsed.push({
      title,
      url: href,
      snippet: await readSnippet(item.locator(SNIPPET_SELECTOR).first()),
      source: "startpage",
    });
  }

  return parsed;
}

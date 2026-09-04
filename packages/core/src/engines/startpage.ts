import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import { clickThroughResult } from "../browser/click-through.js";
import { searchDwell } from "../browser/dwell.js";
import { humanPause, humanType } from "../browser/human.js";
import { assessRelevance } from "../relevance.js";
import type { SearchEngine, SearchQuery, SearchResult, SearchSession } from "../types.js";
import { NoResultsError, OffTargetResultsError } from "./errors.js";

/**
 * Startpage, driven through a real browser the way a person would drive it.
 *
 * Startpage is a proxy rather than an index of its own: it serves mostly
 * Google's results with some of Bing's mixed in. Running it alongside the
 * `bing` engine therefore returns overlapping results by design — what it adds
 * is Google's ranking, which nothing else here reaches.
 *
 * Same interaction as the other engines — homepage first, type, submit, parse,
 * check relevance, then dwell and occasionally click through as
 * `SearchSession.completed`. See bing.ts for why the shape is that way; below
 * is only what Startpage does differently.
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
 * - **`textContent` can pick up CSS here, and the fix is not `innerText`.**
 *   The styling library inserts its `<style>` elements next to the component
 *   they belong to during hydration, before relocating them to the head. Parse
 *   soon enough after load — which this engine does, since it reads as soon as
 *   the results attach — and a result's title still contains a style element,
 *   whose rule text `textContent` happily returns: titles come back reading
 *   `.css-i3irj7{line-height:18px;...}Best waterpark in Chicago?`. Reading
 *   `innerText` instead would fix this one thing and reintroduce the CSS
 *   clipping problem, so text is read from the DOM with style and script
 *   nodes removed. This was found against the live site; a captured fixture
 *   cannot reproduce it, because by the time a page is captured the styles
 *   have been moved.
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

/** Default result count, matching one Startpage page. */
const DEFAULT_LIMIT = 10;

export class StartpageSearchEngine implements SearchEngine {
  readonly id = "startpage";
  readonly name = "Startpage";

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

    const parsed = await parseStartpageResults(results, limit);
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
 * `#q` is the id; the field's name is `query`, so the usual `[name='q']`
 * fallback would not find it and is deliberately not listed. Resolved once and
 * reused, rather than re-queried per keystroke.
 */
function searchBox(page: Page): Locator {
  return page.locator("#q, input[name='query']").first();
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
export async function parseStartpageResults(results: Locator, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
  const available = await results.count();
  const parsed: SearchResult[] = [];

  for (let i = 0; i < available && parsed.length < limit; i++) {
    const item = results.nth(i);

    const link = item.locator(LINK_SELECTOR).first();
    // A result block with no title link is a layout variant, not a result we
    // can return.
    if ((await link.count()) === 0) continue;

    const [href, rawTitle] = await Promise.all([
      link.getAttribute("href", { timeout: EXTRACT_TIMEOUT_MS }).catch(() => null),
      readText(link, EXTRACT_TIMEOUT_MS),
    ]);

    const title = collapse(rawTitle);
    // Startpage links direct, so this is a plain sanity check rather than the
    // guard against a half-decoded redirect that Bing's parser needs.
    if (!href?.startsWith("http") || !title) continue;

    const snippetEl = item.locator(SNIPPET_SELECTOR).first();
    const snippet = (await snippetEl.count()) > 0 ? collapse(await readText(snippetEl, EXTRACT_TIMEOUT_MS)) : "";

    parsed.push({
      title,
      url: href,
      snippet: snippet || undefined,
      source: "startpage",
    });
  }

  return parsed;
}

/**
 * Reads an element's text without the contents of any `<style>` or `<script>`
 * it contains.
 *
 * `textContent` is the DOM's text, which is what makes it immune to CSS
 * clipping — and also what makes it hand back stylesheet source when a style
 * element is sitting inside the node being read. Subtracting those keeps the
 * property worth having and drops the one that hurts.
 *
 * Done through locators rather than `evaluate`, because core is compiled
 * without the DOM lib and so cannot type a page-side callback, and a string
 * expression is not an option: Playwright only passes the element to a real
 * function, so `locator.evaluate("el => …")` silently resolves undefined.
 * The `count()` guard keeps the extra round trip off the ordinary path, where
 * there is no style element to subtract.
 */
async function readText(el: Locator, timeout: number): Promise<string | null> {
  const raw = await el.textContent({ timeout }).catch(() => null);
  if (raw === null) return null;

  const noise = el.locator("style, script");
  if ((await noise.count()) === 0) return raw;

  let text = raw;
  for (const chunk of await noise.allTextContents()) {
    // Each style's text is a literal substring of its parent's textContent.
    if (chunk) text = text.replace(chunk, "");
  }
  return text;
}

/** Collapses runs of whitespace, since textContent preserves the markup's. */
function collapse(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

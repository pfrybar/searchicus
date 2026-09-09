import type { Locator, Page } from "playwright";
import type { SearchContext } from "../context.js";
import { clickThroughResult } from "../browser/click-through.js";
import { searchDwell } from "../browser/dwell.js";
import { humanPause, humanType } from "../browser/human.js";
import { assessRelevance } from "../relevance.js";
import type { SearchQuery, SearchResult, SearchSession } from "../types.js";
import { NoResultsError, OffTargetResultsError, SearchBoxUnavailableError } from "./errors.js";

/**
 * The interaction every engine here performs, in one place.
 *
 * All four engines drive their site the same way, and the sequence is the
 * point rather than an accident:
 *
 * - **Homepage first, then typing.** Navigating straight to `/search?q=...`
 *   is one request with no referer and no interaction history. Loading the
 *   homepage, focusing the box and typing produces both, and costs one extra
 *   page load. The URL is never constructed at all — the form builds it. On
 *   Startpage this is not even a preference: its results page is a POST, so
 *   there is no URL to construct.
 * - **Results are checked for relevance before they are believed.** See
 *   relevance.ts: a search engine can answer a multi-word query with results
 *   for only its first term, and that arrives as a valid, parseable, entirely
 *   wrong page.
 * - **The dwell and optional click-through run after parsing, not before.**
 *   They are handed back as `SearchSession.completed`, so the caller has
 *   results while the page is still being read and occasionally clicked.
 *   Awaiting them first would add their full delay to every search before any
 *   output appeared.
 *
 * What differs between engines is which elements to look at and how to read
 * one result — that is `BrowserSearchSpec`, which each engine implements
 * itself. Selector choices are deliberately *not* centralised here: they are
 * the part that rots, and each site rots differently.
 */

/** How long to wait for the homepage. Bounded so failures are specific. */
const NAVIGATION_TIMEOUT_MS = 15_000;
/** How long to wait for a results page after submitting the query. */
const RESULTS_TIMEOUT_MS = 10_000;
/**
 * How long to wait for the search box before giving up on it.
 *
 * `pressSequentially` auto-waits with Playwright's 30s default, so an
 * unbounded wait on a renamed search box spends the registry's entire 30s
 * results budget typing into nothing, then fails with a raw Playwright
 * timeout naming a locator. The box is confirmed present here first, and
 * typing is bounded separately, so the failure is both fast and says which
 * engine's box has moved.
 */
const SEARCH_BOX_TIMEOUT_MS = 5_000;
/** Per-keystroke budget once the box is known to be there. */
const TYPING_TIMEOUT_MS = 5_000;

/**
 * What one engine has to supply for {@link runBrowserSearch} to drive it.
 *
 * An engine class implements this directly, so its `id` and `name` serve both
 * the `SearchEngine` interface and the error messages here.
 */
export interface BrowserSearchSpec {
  /** Engine id; also each result's `source`. */
  readonly id: string;
  /** Human-readable name, used in failures. */
  readonly name: string;
  /** Where the session starts. The results URL is built by submitting a form. */
  readonly homepage: string;
  /** A result's destination link, for the click-through to follow. */
  readonly linkSelector: string;
  /**
   * Candidate search inputs, *not* narrowed to one.
   *
   * Return the whole union and let the flow pick: a comma selector is matched
   * in document order, not in the order its alternatives are written, so
   * `page.locator("#q, input[name='query']").first()` does not mean "prefer
   * `#q`" — it means "whichever comes first in the DOM". On Startpage that is
   * a hidden `<input type="hidden" name="query">`, and typing into it can
   * never work. The flow filters to visible elements before choosing.
   */
  searchBox(page: Page): Locator;
  /** The organic results, in page order. */
  results(page: Page): Locator;
  /** Reads every eligible result from an already-loaded SERP. */
  parse(results: Locator): Promise<SearchResult[]>;
}

/** The background phase: what keeps happening after results are returned. */
export type CompleteSession = (
  page: Page,
  results: Locator,
  linkSelector: string,
  signal: AbortSignal,
) => Promise<void>;

export interface RunBrowserSearchOptions {
  /**
   * Substitute for the dwell and click-through.
   *
   * The default is the real thing and is what production always uses. It is
   * injectable because the background phase deliberately takes 5-10s of wall
   * time, which is the one part of this flow a test cannot both exercise and
   * stay fast for; a test that is not about the dwell passes a no-op.
   */
  complete?: CompleteSession;
  /**
   * Source of randomness for the interaction's pacing.
   *
   * Production uses `Math.random`, which is the point — the pauses are
   * heavy-tailed precisely so the timing is not a signature. A test that is
   * about the flow rather than the pacing passes a fixed draw, which pins
   * every pause to the low end of its range instead of waiting out several
   * seconds of deliberate hesitation per search.
   */
  random?: () => number;
}

/** Runs one search against `spec`'s site and returns its two-phase session. */
export async function runBrowserSearch(
  spec: BrowserSearchSpec,
  query: SearchQuery,
  ctx: SearchContext,
  options: RunBrowserSearchOptions = {},
): Promise<SearchSession> {
  // Timed from here so tookMs covers acquiring the browser and the whole
  // interaction, which is the number worth knowing.
  const start = Date.now();

  const { page } = await ctx.acquireBrowser();

  await page.goto(spec.homepage, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  // Visible-only, because engines hand back a union of candidate selectors
  // and pages carry hidden inputs that match them — see BrowserSearchSpec.
  const box = spec.searchBox(page).filter({ visible: true }).first();
  try {
    await box.waitFor({ state: "visible", timeout: SEARCH_BOX_TIMEOUT_MS });
  } catch (err) {
    throw new SearchBoxUnavailableError(spec.name, page.url(), err);
  }

  // Read the page before starting to type, as a person would.
  const random = options.random ?? Math.random;
  await humanPause(400, 1200, ctx.signal, random);
  await humanType(box, query.query, ctx.signal, TYPING_TIMEOUT_MS, random);
  await humanPause(400, 1000, ctx.signal, random);
  await box.press("Enter");

  const results = spec.results(page);
  try {
    await results.first().waitFor({ state: "attached", timeout: RESULTS_TIMEOUT_MS });
  } catch (err) {
    throw new NoResultsError(spec.name, page.url(), err);
  }

  const parsed = await spec.parse(results);
  if (parsed.length === 0) throw new NoResultsError(spec.name, page.url());

  const report = assessRelevance(query.query, parsed);
  if (report.offTarget) throw new OffTargetResultsError(spec.name, query.query, report);

  return {
    response: {
      query,
      results: parsed,
      engine: spec.id,
      tookMs: Date.now() - start,
    },
    // Results are ready; the page is dwelled on and then occasionally clicked
    // through in the background. The registry holds the browser lease until
    // this settles; both phases are best-effort and never reject.
    completed: (options.complete ?? completeSearchSession)(page, results, spec.linkSelector, ctx.signal),
  };
}

/** Finishes the background browser behavior after results have been returned. */
export async function completeSearchSession(
  page: Page,
  results: Locator,
  linkSelector: string,
  signal: AbortSignal,
): Promise<void> {
  await searchDwell(page, results, signal);
  await clickThroughResult(page, results, signal, { linkSelector });
}

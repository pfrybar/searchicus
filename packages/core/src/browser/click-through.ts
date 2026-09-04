import type { Locator, Page } from "playwright";
import { humanPause } from "./human.js";

/** Fraction of searches that click through an organic result after dwelling. */
export const CLICK_THROUGH_RATE = 0.4;

/**
 * Selects the destination link inside one result block, when the engine does
 * not say. Result markup is engine-specific — Bing's title link is `h2 a`,
 * Brave's is an anchor wrapping a `div.title` and has no heading element at
 * all — so an engine whose results differ passes its own selector. A wrong
 * selector here is silent: the count guard below reads zero and the search
 * simply never clicks through.
 */
const DEFAULT_LINK_SELECTOR = "h2 a";

/** The top ranks considered for a click, weighted toward the first result. */
const RANK_WEIGHTS = [0.45, 0.25, 0.15, 0.09, 0.06] as const;

export interface ClickThroughOptions {
  /** Fraction of searches that click through; defaults to CLICK_THROUGH_RATE. */
  rate?: number;
  /** How to find a result's destination link; defaults to Bing's `h2 a`. */
  linkSelector?: string;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Selects an organic-result rank from the first five results, weighted toward
 * the top of the page. The available weights are renormalized when fewer than
 * five results exist, so every selected rank is valid.
 */
export function chooseClickThroughIndex(resultCount: number, random: () => number = Math.random): number | undefined {
  const candidates = Math.min(resultCount, RANK_WEIGHTS.length);
  if (candidates <= 0) return undefined;

  const weights = RANK_WEIGHTS.slice(0, candidates);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = random() * total;

  for (let index = 0; index < weights.length; index++) {
    target -= weights[index] ?? 0;
    if (target < 0) return index;
  }

  return candidates - 1;
}

/**
 * Best-effort click-through after a search-results dwell.
 *
 * Zero-click searches are ordinary, and always clicking would add unnecessary
 * traffic to arbitrary result sites. This runs on 40% of searches and selects
 * only an organic Bing result, with a weighted preference for higher ranks.
 * A real locator click preserves Bing's ordinary click and referrer behavior.
 * If it opens a popup, that click-owned page stays open for the landing pause
 * and is then closed, rather than leaking outside the browser lease. The helper
 * deliberately does not construct a destination URL or perform a full
 * destination-page dwell.
 *
 * This is decorative browser behavior, like searchDwell(): it always settles
 * and never turns an already-successful search into a failed one.
 */
export async function clickThroughResult(
  page: Page,
  resultEls: Locator,
  signal?: AbortSignal,
  options: ClickThroughOptions = {},
): Promise<void> {
  let popupPromise: Promise<Page | undefined> | undefined;
  let popup: Page | undefined;

  try {
    const random = options.random ?? Math.random;
    const rate = options.rate ?? CLICK_THROUGH_RATE;
    signal?.throwIfAborted();
    if (random() >= rate) return;

    const index = chooseClickThroughIndex(await resultEls.count(), random);
    if (index === undefined) return;

    const link = resultEls
      .nth(index)
      .locator(options.linkSelector ?? DEFAULT_LINK_SELECTOR)
      .first();
    // Locator actions auto-wait, so checking count first keeps layout variants
    // without a linked title from consuming the default action timeout.
    if ((await link.count()) === 0) return;

    // Register before clicking so a target=_blank result cannot race past the
    // listener. The page-level event is scoped to this SERP, unlike a shared
    // BrowserContext "page" event that could belong to another search.
    popupPromise = page.waitForEvent("popup", { timeout: 1_000 }).catch(() => undefined);

    // A small decision beat separates reading the SERP from opening a result.
    await humanPause(250, 750, signal);
    await link.click({ timeout: 5_000, signal });
    popup = await popupPromise;
    // Stay on the destination briefly rather than closing its page the moment
    // the navigation starts. This is intentionally lighter than extractDwell.
    await humanPause(700, 1_800, signal);
  } catch {
    // A click-through is optional: aborted, detached, blocked, and failed
    // navigations must all leave the successful search response intact.
  } finally {
    // A click can open a popup even when the action itself later fails. Await
    // the already-caught event promise here so every click-owned popup closes.
    popup ??= await popupPromise;
    await popup?.close().catch(() => undefined);
  }
}

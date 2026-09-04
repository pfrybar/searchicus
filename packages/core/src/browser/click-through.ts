import type { Locator } from "playwright";
import { humanPause } from "./human.js";

/** Fraction of searches that click through an organic result after dwelling. */
export const CLICK_THROUGH_RATE = 0.4;

/** The top ranks considered for a click, weighted toward the first result. */
const RANK_WEIGHTS = [0.45, 0.25, 0.15, 0.09, 0.06] as const;

export interface ClickThroughOptions {
  /** Fraction of searches that click through; defaults to CLICK_THROUGH_RATE. */
  rate?: number;
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
 * A real locator click preserves Bing's ordinary click and referrer behavior;
 * it deliberately does not construct a destination URL or perform a full
 * destination-page dwell. Short pauses before and after the click model the
 * decision to open a result and the landing on its destination.
 *
 * This is decorative browser behavior, like searchDwell(): it always settles
 * and never turns an already-successful search into a failed one.
 */
export async function clickThroughResult(
  resultEls: Locator,
  signal?: AbortSignal,
  options: ClickThroughOptions = {},
): Promise<void> {
  try {
    const random = options.random ?? Math.random;
    const rate = options.rate ?? CLICK_THROUGH_RATE;
    signal?.throwIfAborted();
    if (random() >= rate) return;

    const index = chooseClickThroughIndex(await resultEls.count(), random);
    if (index === undefined) return;

    const link = resultEls.nth(index).locator("h2 a").first();
    // Locator actions auto-wait, so checking count first keeps layout variants
    // without a linked heading from consuming the default action timeout.
    if ((await link.count()) === 0) return;

    // A small decision beat separates reading the SERP from opening a result.
    await humanPause(250, 750, signal);
    await link.click({ timeout: 5_000, signal });
    // Stay on the destination briefly rather than closing its page the moment
    // the navigation starts. This is intentionally lighter than extractDwell.
    await humanPause(700, 1_800, signal);
  } catch {
    // A click-through is optional: aborted, detached, blocked, and failed
    // navigations must all leave the successful search response intact.
  }
}

import type { Locator, Page } from "playwright";
import { humanPause, randInt } from "./human.js";

/**
 * The post-load behavioural dwell: the "read, scan, look" phase of a real
 * session, run after a results page has loaded *and been parsed*.
 *
 * This is what `SearchSession.completed` is for. An engine returns its
 * results the moment it has them and hands the dwell back as `completed`;
 * the registry keeps the browser lease open until the dwell settles and the
 * caller waits for none of it. Awaiting a dwell *before* parsing would pay
 * its full 5-10s before producing any output, which is precisely what the
 * two-phase split exists to avoid; the ordering is the whole point.
 *
 * Design constraints:
 *
 * - **network-neutral**: wheel scrolling and hovering generate zero
 *   requests, so a dwell adds no load to the destination and cannot trip a
 *   per-page rate limit;
 * - **no clicks**: a zero-click exit from a results page is statistically
 *   ordinary — most searches end without one;
 * - **non-uniform**: every pause and step count is drawn from the same
 *   heavy-tailed distributions as the other interaction primitives.
 *
 * Wall time is deliberately ~5-10s, which fits inside the registry's 60s
 * session budget without touching its 30s results budget.
 *
 * **These never reject.** A session that never settles leaks a page into a
 * browser meant to run for days, and a dwell is decoration — a layout change
 * only means a slightly less human-looking session, never a failed search.
 * Both functions swallow everything, including the abort that shutdown
 * raises through `humanPause`.
 */

/**
 * A plausible scan of a search-results page: settle, hover over one or two
 * results, scroll down through them in a few wheel steps, and occasionally
 * scroll back up a little before stopping.
 *
 * Pass `signal` so a shutdown or an expired session deadline cuts the dwell
 * short instead of the registry having to force it.
 */
export async function searchDwell(
  page: Page,
  resultEls?: Locator,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<void> {
  try {
    // 1. settle: the read-before-scroll beat
    await humanPause(1000, 2500, signal, random);

    // 2. hover over one or two results, if the engine told us where they are
    if (resultEls) {
      const want = randInt(1, 2, random);
      for (let i = 0; i < want; i++) {
        const count = await resultEls.count();
        if (count === 0) break;
        const el = resultEls.nth(randInt(0, count - 1, random));
        await el.hover({ timeout: 2_000 }).catch(() => undefined);
        await humanPause(400, 1500, signal, random);
      }
    }

    // 3. scroll down through the results
    for (let i = 0, steps = randInt(2, 3, random); i < steps; i++) {
      await page.mouse.wheel(0, randInt(300, 550, random)).catch(() => undefined);
      await humanPause(500, 1500, signal, random);
    }

    // 4. sometimes a small scroll back up, then stop
    if (random() < 0.3) {
      await page.mouse.wheel(0, -randInt(150, 300, random)).catch(() => undefined);
      await humanPause(400, 1000, signal, random);
    }
  } catch {
    // A dwell is decorative: it must always settle, even when aborted or its
    // page disappears during shutdown.
  }
}

/**
 * The lighter dwell for reading a single extracted page: settle while lazy
 * content renders, one or two short scrolls, then stop (~1-4s).
 */
export async function extractDwell(
  page: Page,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<void> {
  try {
    await humanPause(1000, 2000, signal, random);

    for (let i = 0, steps = randInt(1, 2, random); i < steps; i++) {
      await page.mouse.wheel(0, randInt(250, 400, random)).catch(() => undefined);
      await humanPause(300, 900, signal, random);
    }

    await humanPause(200, 600, signal, random);
  } catch {
    // A dwell is decorative: it must always settle, even when aborted or its
    // page disappears during shutdown.
  }
}

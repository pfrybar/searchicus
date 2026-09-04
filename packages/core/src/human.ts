import type { Locator, Page } from "playwright";
import { sleep } from "./throttle.js";

/**
 * Human-like interaction primitives: jittered pauses, wandering cursor
 * drift, character-by-character typing.
 *
 * The point is behavioural consistency rather than slowness for its own
 * sake. A real cursor drifts in small *relative* steps and never teleports
 * across the viewport; real pauses are heavy-tailed rather than uniform. A
 * bot fires instant, perfectly uniform sequences, and a flat distribution is
 * itself a recognizable profile. Everything here is deliberately non-uniform.
 *
 * These pace work *within* a page. The registry's Throttle paces whole
 * search fan-outs *between* each other. They are complementary and do not
 * interact.
 *
 * Playwright is imported for types only, so this module never pulls a
 * browser binary into anyone's bundle.
 */

/** Uniform random integer in [lo, hi], inclusive. */
export function randInt(lo: number, hi: number, random: () => number = Math.random): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/**
 * A "human" pause: 80% short, 15% medium (220-600ms), 5% a longer
 * hesitation (600-1400ms). One uniform draw has a detectably flat profile;
 * this mixture has the heavy tail real people produce.
 *
 * Takes an AbortSignal rather than a Page (which the reference version used
 * solely for `page.waitForTimeout`). That makes every pause cancellable, so
 * shutdown and the registry's session deadline interrupt a dwell promptly
 * instead of waiting it out. Rejects with ThrottleAbortError when aborted —
 * callers that must not fail (see dwell.ts) swallow it.
 */
export async function humanPause(
  baseLo = 40,
  baseHi = 220,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<void> {
  const r = random();
  const ms =
    r < 0.8 ? randInt(baseLo, baseHi, random) : r < 0.95 ? randInt(220, 600, random) : randInt(600, 1400, random);
  await sleep(ms, signal);
}

/**
 * Types `text` into `locator` one character at a time, with a heavy-tailed
 * delay between keystrokes.
 *
 * The locator is resolved once by the caller and reused, rather than
 * re-queried per character: a per-character lookup is both slow and, on a
 * page whose search box is A/B tested, fragile.
 */
export async function humanType(locator: Locator, text: string, signal?: AbortSignal): Promise<void> {
  for (const char of text) {
    await humanPause(40, 130, signal);
    await locator.pressSequentially(char);
  }
}

/**
 * Moves the mouse in a few small wandering steps.
 *
 * Each step is a short relative drift from wherever the cursor already is,
 * clamped to the viewport and interpolated over several intermediate points.
 * A minority of beats are rests, like a hand pausing over the page. Reads the
 * live cursor position that STEALTH_INIT tracks; falls back to a plausible
 * resting spot when the page has not reported one yet.
 */
export async function humanWander(page: Page, moves = 4, signal?: AbortSignal): Promise<void> {
  let { x, y } = await cursorPos(page);

  for (let i = 0; i < moves; i++) {
    await humanPause(200, 900, signal);
    if (Math.random() < 0.15) continue; // rest: no movement this beat
    x = clamp(x + randInt(-180, 180), 10, 1500);
    y = clamp(y + randInt(-130, 130), 10, 840);
    // A mouse move failing (navigation mid-gesture, detached page) is not a
    // reason to fail the search that owns this page.
    await page.mouse.move(x, y, { steps: randInt(4, 12) }).catch(() => undefined);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

/**
 * Where the cursor is, per the position STEALTH_INIT records. Falls back to
 * the lower-right, where a hand rests on a laptop.
 *
 * Passed to `evaluate` as a string expression rather than a closure because
 * it runs in the browser realm: core's tsconfig has no DOM lib, so a closure
 * referencing `window` would not typecheck.
 */
async function cursorPos(page: Page): Promise<{ x: number; y: number }> {
  try {
    const pos = await page.evaluate<{ x: number; y: number }>(
      `({ x: window.__mouseX ?? -1, y: window.__mouseY ?? -1 })`,
    );
    if (pos.x >= 0 && pos.y >= 0) return pos;
  } catch {
    // No page context to ask (navigating, closed). The fallback is fine.
  }

  return { x: randInt(700, 1200), y: randInt(400, 700) };
}

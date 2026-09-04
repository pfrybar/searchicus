import type { Locator, Page } from "playwright";
import { sleep } from "../throttle.js";

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
 * A "human" pause: 80% a short beat in the caller's own range, 15% a medium
 * one (220-420ms), 5% a longer hesitation (420-1000ms). One uniform draw has
 * a detectably flat profile; this mixture has the heavy tail real people
 * produce.
 *
 * Pausing is driven by an AbortSignal rather than `page.waitForTimeout`, so
 * every pause is cancellable and shutdown or the registry's session deadline
 * interrupts a dwell promptly instead of waiting it out. Rejects with
 * ThrottleAbortError when aborted — callers that must not fail (see dwell.ts)
 * swallow it.
 */
export async function humanPause(
  baseLo = 40,
  baseHi = 220,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<void> {
  const r = random();
  const ms =
    r < 0.8 ? randInt(baseLo, baseHi, random) : r < 0.95 ? randInt(220, 420, random) : randInt(420, 1000, random);
  await sleep(ms, signal);
}

/**
 * Types `text` into `locator` one character at a time, with a heavy-tailed
 * delay between keystrokes.
 *
 * The locator is resolved once by the caller and reused, rather than
 * re-queried per character: a per-character lookup is both slow and, on a
 * page whose search box is A/B tested, fragile.
 *
 * `timeoutMs` bounds each keystroke. Without it `pressSequentially` uses
 * Playwright's 30s default, so typing into a box that has been renamed or has
 * detached mid-gesture blocks long enough to consume the registry's entire
 * results budget before anything reports a problem — the same auto-wait trap
 * the parsers guard against with `count()`, on the input side.
 */
export async function humanType(
  locator: Locator,
  text: string,
  signal?: AbortSignal,
  timeoutMs = 5_000,
  random: () => number = Math.random,
): Promise<void> {
  for (const char of text) {
    await humanPause(40, 130, signal, random);
    await locator.pressSequentially(char, { timeout: timeoutMs });
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
export async function humanWander(
  page: Page,
  moves = 4,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<void> {
  let { x, y } = await cursorPos(page, random);

  for (let i = 0; i < moves; i++) {
    await humanPause(200, 900, signal, random);
    if (random() < 0.15) continue; // rest: no movement this beat
    x = clamp(x + randInt(-180, 180, random), 10, 1500);
    y = clamp(y + randInt(-130, 130, random), 10, 840);
    // A mouse move failing (navigation mid-gesture, detached page) is not a
    // reason to fail the search that owns this page.
    await page.mouse.move(x, y, { steps: randInt(4, 12, random) }).catch(() => undefined);
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
async function cursorPos(page: Page, random: () => number = Math.random): Promise<{ x: number; y: number }> {
  try {
    const pos = await page.evaluate<{ x: number; y: number }>(
      `({ x: window.__mouseX ?? -1, y: window.__mouseY ?? -1 })`,
    );
    if (pos.x >= 0 && pos.y >= 0) return pos;
  } catch {
    // No page context to ask (navigating, closed). The fallback is fine.
  }

  return { x: randInt(700, 1200, random), y: randInt(400, 700, random) };
}

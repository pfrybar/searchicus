import type { Locator } from "playwright";

/**
 * Shared helpers for reading results out of a loaded SERP.
 *
 * Two rules hold across every engine here, and both were learned from live
 * sites rather than reasoned about in advance:
 *
 * - **Guard every read with `count()` first.** Playwright's text and
 *   attribute readers *auto-wait*, so reading a field a result does not have
 *   blocks for the full default timeout (30s) before any `catch` runs — on
 *   its own enough to exhaust the registry's whole results budget. `count()`
 *   resolves immediately and never waits.
 * - **Read `textContent`, not `innerText`.** `innerText` is what a *reader*
 *   sees, so it is a function of CSS. A real Bing SERP hid an organic
 *   result's heading with a style rule and `innerText` returned `""` for a
 *   perfectly good result, which the parser then discarded. The specific
 *   trigger is `visibility:hidden`, which `innerText` honours by returning
 *   nothing; `display:none` is *not* it, since an unrendered element falls
 *   back to `textContent` (parse.test.ts pins both). `textContent` reads the
 *   DOM instead of the render, so it does not depend on styling, viewport,
 *   fonts, or how the headless renderer lays the page out.
 */

/**
 * Per-field read budget once the SERP is loaded. Nothing should ever wait —
 * the page is already rendered — so this only bounds a pathological case
 * rather than being part of normal operation.
 */
export const EXTRACT_TIMEOUT_MS = 2_000;

/**
 * Reads an element's text, without the contents of any `<style>` or
 * `<script>` it happens to contain.
 *
 * `textContent` returning the DOM's text is what makes it immune to CSS
 * clipping — and also what makes it hand back stylesheet source when a style
 * element is sitting inside the node being read. That is not hypothetical:
 * Startpage's CSS-in-JS inserts each `<style>` next to its own component
 * during hydration before relocating it to the head, and parsing as soon as
 * results attach caught titles reading
 * `.css-i3irj7{line-height:18px;...}Best waterpark in Chicago?`. Reaching for
 * `innerText` to fix that would bring the clipping problem straight back, so
 * the style and script text is subtracted instead.
 *
 * Every engine uses this rather than only the one where it was found. Whether
 * a site trips it is a matter of *when* a parse happens relative to
 * hydration, not a fixed property of the site, so "this engine doesn't need
 * it" is a statement with a shelf life.
 *
 * The removal happens **in the page, on a clone, in one call**, and it has to.
 * An earlier version read `textContent` and then subtracted the text of any
 * `<style>` descendants it could still find, which is a time-of-check race
 * against the very hydration that causes the problem: by the time the second
 * read ran, Startpage had already relocated the style to `<head>`, the
 * selector matched nothing, and the CSS stayed in the title. Live archives
 * show it — `.css-i3irj7{line-height:18px;...}` shipped as a result title.
 * Two reads cannot be made safe here, because the DOM is changing underneath
 * them; one read can.
 *
 * The callback is a real function rather than a string, because Playwright
 * only passes the element to a real one — `locator.evaluate("el => …")`
 * silently resolves undefined. Core is compiled without the DOM lib, so the
 * node is cast to the minimum shape this needs rather than typed as an
 * element; that compiles cleanly and keeps the DOM lib out of the package.
 * Cloning leaves the live page untouched.
 */
export async function readText(el: Locator, timeout = EXTRACT_TIMEOUT_MS): Promise<string | null> {
  return el
    .evaluate(
      (node) => {
        const clone = (node as { cloneNode(deep: boolean): unknown }).cloneNode(true) as {
          querySelectorAll(selector: string): Iterable<{ remove(): void }>;
          textContent: string | null;
        };
        for (const noise of clone.querySelectorAll("style, script")) noise.remove();
        return clone.textContent;
      },
      undefined,
      { timeout },
    )
    .catch(() => null);
}

/**
 * Reads an element's text and collapses its whitespace, or returns `""` when
 * the element is not there. The collapsing is needed because `textContent`
 * preserves whatever whitespace the markup has.
 */
export async function readCollapsed(el: Locator, timeout = EXTRACT_TIMEOUT_MS): Promise<string> {
  return collapse(await readText(el, timeout));
}

/** Collapses runs of whitespace, since textContent preserves the markup's. */
export function collapse(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Reads an optional description, returning `undefined` rather than `""` when
 * a result has none — the shape `SearchResult.snippet` wants. The `count()`
 * guard is what keeps a result with no description cheap.
 */
export async function readSnippet(el: Locator, timeout = EXTRACT_TIMEOUT_MS): Promise<string | undefined> {
  if ((await el.count()) === 0) return undefined;
  return (await readCollapsed(el, timeout)) || undefined;
}

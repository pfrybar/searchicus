import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collapse, isWebUrl, readCollapsed, readSnippet, readText } from "./parse.js";

describe("collapse", () => {
  it("collapses the whitespace textContent preserves", () => {
    expect(collapse("  Best   waterpark\n  in Chicago ")).toBe("Best waterpark in Chicago");
  });

  it("treats a missing value as empty", () => {
    expect(collapse(null)).toBe("");
  });
});

async function chromiumAvailable(): Promise<Browser | undefined> {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch({ channel: "chromium" });
  } catch {
    return undefined;
  }
}

const browser = await chromiumAvailable();

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!browser)("readText", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage();
  });

  it("survives the style being relocated while the element is read", async () => {
    await page.setContent(`<a id="t"><style>.css-x{color:red}</style>Reciprocal rank fusion</a>`);
    const link = page.locator("#t");

    // The regression this replaced a two-read implementation for. That one
    // captured textContent, then looked for `<style>` descendants to subtract
    // — and hydration had already moved the style to `<head>` by then, so it
    // found none and shipped the CSS inside the title. Removing the style
    // between "load" and the read reproduces exactly that ordering.
    await page.locator("#t style").evaluate((node) => (node as { remove(): void }).remove());

    expect(await readText(link)).toBe("Reciprocal rank fusion");
  });

  it("drops CSS that a styling library parks inside the element mid-hydration", async () => {
    // Found against Startpage's live site, and not reproducible from a
    // captured fixture: the styling library inserts each `<style>` next to
    // its own component before relocating it to the head, so an element read
    // soon enough after load still contains one. `textContent` returns its
    // rule text, and titles came back as
    // ".css-i3irj7{line-height:18px;...}Best waterpark in Chicago?".
    // This rebuilds that state rather than pretending a capture holds it.
    await page.setContent(
      `<a id="title"><style data-emotion="css i3irj7">.css-i3irj7{line-height:18px;color:#2E39B3;}</style>` +
        `Best waterpark in Chicago? : r/LoganSquare - Reddit</a>`,
    );

    expect(await readCollapsed(page.locator("#title"))).toBe("Best waterpark in Chicago? : r/LoganSquare - Reddit");
  });

  it("drops script text too", async () => {
    await page.setContent(`<p id="p"><script>var tracking = 1;</script>A real description.</p>`);

    expect(await readCollapsed(page.locator("#p"))).toBe("A real description.");
  });

  it("reads text the page hides, which is why innerText is not the fix", async () => {
    // The Bing failure this rule came from, reduced: a heading hidden by a
    // style rule read as "" through innerText, so the parser discarded a
    // perfectly good result.
    await page.setContent(`<h2 id="h" style="visibility:hidden">TOP 10 BEST Water Parks in Chicago, IL - Yelp</h2>`);

    expect(await page.locator("#h").innerText()).toBe("");
    expect(await readCollapsed(page.locator("#h"))).toBe("TOP 10 BEST Water Parks in Chicago, IL - Yelp");
  });

  it("pins which CSS actually defeats innerText, since the obvious guess is wrong", async () => {
    // `display:none` looks like the dangerous case and is not: an unrendered
    // element's innerText falls back to textContent. `visibility:hidden` is
    // the one that empties it. Worth pinning, because a comment claiming the
    // wrong mechanism teaches the next person a rule that does not hold.
    const hidden = { "display:none": false, "visibility:hidden": true };

    for (const [css, empties] of Object.entries(hidden)) {
      await page.setContent(`<h2 id="h" style="${css}">Raging Waves</h2>`);
      expect(await page.locator("#h").innerText(), css).toBe(empties ? "" : "Raging Waves");
    }
  });

  it("leaves ordinary text alone", async () => {
    await page.setContent(`<p id="p">Raging Waves - Illinois' Largest Waterpark</p>`);

    expect(await readText(page.locator("#p"))).toBe("Raging Waves - Illinois' Largest Waterpark");
  });

  it("returns null when the element is not there rather than waiting for it", async () => {
    // The auto-wait trap: an unguarded read of an absent element blocks for
    // Playwright's full 30s default before any catch runs.
    await page.setContent(`<p>nothing to see</p>`);

    const started = Date.now();
    expect(await readText(page.locator("#missing"), 500)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe.skipIf(!browser)("readSnippet", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage();
  });

  it("is undefined when a result has no description, not an empty string", async () => {
    await page.setContent(`<div id="result"><h2>A title</h2></div>`);

    expect(await readSnippet(page.locator("#result p"))).toBeUndefined();
  });

  it("is undefined when the description is present but empty", async () => {
    await page.setContent(`<div id="result"><p>   </p></div>`);

    expect(await readSnippet(page.locator("#result p"))).toBeUndefined();
  });

  it("reads a description when there is one", async () => {
    await page.setContent(`<div id="result"><p>  What are people   saying?  </p></div>`);

    expect(await readSnippet(page.locator("#result p"))).toBe("What are people saying?");
  });
});

describe("isWebUrl", () => {
  it("accepts the absolute web URLs a result can actually have", () => {
    expect(isWebUrl("https://example.com/a?b=1#c")).toBe(true);
    expect(isWebUrl("http://example.com")).toBe(true);
  });

  it("refuses anything that is not one, including near misses", () => {
    // The old check was startsWith("http"), which let the first two through
    // and excluded the relative forms only by accident.
    for (const href of ["httpfoo://example.com", "https-evil:payload", "javascript:alert(1)", "data:text/html,x"]) {
      expect(isWebUrl(href), href).toBe(false);
    }
    for (const href of ["/results/1", "example.com", "", null, undefined]) {
      expect(isWebUrl(href), String(href)).toBe(false);
    }
  });
});

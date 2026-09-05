import { describe, expect, it } from "vitest";
import { sliceWindow, splitSections } from "./sections.js";

const doc = [
  "Preamble before any heading.",
  "",
  "# Title",
  "",
  "Intro paragraph.",
  "",
  "## First",
  "",
  "```js",
  "// # not a heading, it is a comment",
  "const x = 1;",
  "```",
  "",
  "## Second",
  "",
  "Body of the second section.",
].join("\n");

describe("splitSections", () => {
  it("splits at headings and keeps the text before the first one", () => {
    const sections = splitSections(doc);
    expect(sections.map((s) => s.headings)).toEqual([[], ["Title"], ["Title", "First"], ["Title", "Second"]]);
    expect(sections[0]?.text.trim()).toBe("Preamble before any heading.");
  });

  it("does not cut inside a fenced block", () => {
    // A `#` inside code is a comment in half the languages in the world.
    const first = splitSections(doc).find((s) => s.headings.includes("First"));
    expect(first?.text).toContain("// # not a heading, it is a comment");
    expect(first?.text).toContain("const x = 1;");
  });

  it("keeps offsets that address the original document", () => {
    for (const section of splitSections(doc)) {
      expect(doc.slice(section.start, section.end)).toContain(section.text.trim().split("\n")[0] ?? "");
    }
  });

  it("treats a longer fence as containing a shorter one", () => {
    const nested = ["# T", "", "````", "```", "# still code", "```", "````", "", "## Real"].join("\n");
    expect(splitSections(nested).map((s) => s.headings)).toEqual([["T"], ["T", "Real"]]);
  });

  it("survives markdown with no headings at all", () => {
    expect(splitSections("just a paragraph")).toHaveLength(1);
    expect(splitSections("")).toEqual([]);
  });
});

describe("sliceWindow", () => {
  it("returns the whole document when it fits", () => {
    const window = sliceWindow(doc, { maxChars: 10_000 });
    expect(window.markdown).toBe(doc.trimEnd());
    expect(window.offset).toBe(0);
    expect(window.nextOffset).toBeUndefined();
    expect(window.totalChars).toBe(doc.length);
  });

  it("stops on a section boundary rather than mid-sentence", () => {
    const window = sliceWindow(doc, { maxChars: 60 });
    expect(window.nextOffset).toBeDefined();
    // Whatever it returned, it ended where a section did.
    const starts = new Set(splitSections(doc).map((s) => s.start));
    expect(starts.has(window.nextOffset ?? -1)).toBe(true);
  });

  it("snaps a mid-section offset back to that section's start", () => {
    const second = splitSections(doc).find((s) => s.headings.includes("Second"));
    const window = sliceWindow(doc, { offset: (second?.start ?? 0) + 5, maxChars: 10_000 });
    expect(window.offset).toBe(second?.start);
    expect(window.markdown.startsWith("## Second")).toBe(true);
  });

  it("walks a long document to the end without repeating or skipping", () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${"word ".repeat(30)}`).join("\n\n");
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let guard = 0;

    while (offset !== undefined && guard++ < 200) {
      const window: ReturnType<typeof sliceWindow> = sliceWindow(long, { offset, maxChars: 400 });
      seen.push(window.markdown);
      expect(window.offset).toBeLessThanOrEqual(offset);
      offset = window.nextOffset;
    }

    expect(guard).toBeLessThan(200); // terminated
    // Every section appears exactly once across the walk.
    for (let i = 0; i < 40; i++) {
      expect(seen.filter((chunk) => chunk.includes(`## Section ${i}\n`)).length, `section ${i}`).toBe(1);
    }
  });

  it("serves a section larger than the budget from where it was asked", () => {
    // Snapping here would return the same prefix forever, so the offset is
    // honoured exactly and the cut falls on a word boundary.
    const huge = `## Big\n\n${"word ".repeat(500)}`;
    const first = sliceWindow(huge, { maxChars: 200 });
    expect(first.markdown.length).toBeLessThanOrEqual(200);
    expect(first.nextOffset).toBeGreaterThan(0);

    const second = sliceWindow(huge, { offset: first.nextOffset, maxChars: 200 });
    expect(second.offset).toBe(first.nextOffset);
    expect(second.markdown).not.toBe(first.markdown);
  });

  it("does not end a window inside a fenced code block", () => {
    // Sections never split a fence, but a section longer than the budget has
    // to be cut somewhere, and cutting on the last newline put the cut inside
    // snippets: 22 of 201 windows of nodejs.org/api/sqlite at a 500-character
    // budget handed back code with no closing fence.
    const prose = "Prose long enough that this section cannot fit inside one window of the budget below.";
    const doc = ["## One", "", prose, "", "```js", "const a = 1;", "const b = 2;", "```", "", prose].join("\n");

    let offset: number | undefined = 0;
    let guard = 0;
    while (offset !== undefined && guard++ < 50) {
      const window: ReturnType<typeof sliceWindow> = sliceWindow(doc, { offset, maxChars: 120 });
      const fences = (window.markdown.match(/^ {0,3}```/gm) ?? []).length;
      expect(fences % 2, `window at ${window.offset} ends inside a fence`).toBe(0);
      offset = window.nextOffset;
    }
    expect(guard).toBeLessThan(50);
  });

  it("cuts inside a block only when the block is bigger than the budget", () => {
    // No boundary exists, so this is the one case that must cut inside — at a
    // line, so the damage is whole lines rather than half a statement.
    const huge = ["## One", "", "```js", ...Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`), "```"].join(
      "\n",
    );
    const window = sliceWindow(huge, { maxChars: 300 });
    expect(window.nextOffset).toBeGreaterThan(0);

    const allowed = /^(## One|```js|const x\d+ = \d+;|)$/;
    for (const line of window.markdown.split("\n")) {
      expect(allowed.test(line), `partial line: ${JSON.stringify(line)}`).toBe(true);
    }
  });

  it("clamps an offset past the end instead of failing", () => {
    const window = sliceWindow(doc, { offset: 10_000, maxChars: 100 });
    expect(window.offset).toBeLessThanOrEqual(doc.length);
    expect(window.nextOffset).toBeUndefined();
  });
});

/**
 * Slicing extracted Markdown into windows a caller can read one at a time.
 *
 * The unit is a section, not a character range. A character window is easier
 * to write and cuts through the middle of a fenced code block, which for the
 * technical documentation this is mostly pointed at is the difference between
 * a usable answer and a confusing one. Sections also make the boundary
 * meaningful to a reader: a window starts where a heading does.
 *
 * The same split is what ranked selection will score, so the chunker is built
 * once here rather than twice.
 */

/** One heading and the body beneath it, located in the original document. */
export interface Section {
  /** Character offset of the section's first character in the whole document. */
  readonly start: number;
  /** Character offset one past its last. */
  readonly end: number;
  /** Enclosing headings, outermost first. Empty for text before any heading. */
  readonly headings: readonly string[];
  readonly text: string;
}

export interface MarkdownWindow {
  markdown: string;
  /** Where this window actually starts, after snapping to a boundary. */
  offset: number;
  /** Where to continue reading, or undefined once the end is reached. */
  nextOffset?: number;
  /** Length of the whole document, so a caller knows what it has not seen. */
  totalChars: number;
}

/** ``` or ~~~, three or more, optionally indented up to three spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** ATX headings only. Setext underlines are rare in generated Markdown. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;

/**
 * Splits Markdown into sections at heading boundaries.
 *
 * Fence tracking is the whole reason this is a parser and not a `split()`: a
 * `#` inside a code block is a comment in half the languages in the world,
 * and treating it as a heading would cut a snippet in two.
 */
export function splitSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  const headings: string[] = [];

  let fence: string | undefined;
  let startLine = 0;
  let startOffset = 0;
  let offset = 0;
  // Headings enclosing the section being accumulated, captured before the
  // heading that ends it changes them.
  let openHeadings: string[] = [];

  const close = (endOffset: number, endLine: number): void => {
    const text = lines.slice(startLine, endLine).join("\n");
    if (text.trim().length > 0) {
      sections.push({ start: startOffset, end: endOffset, headings: [...openHeadings], text });
    }
  };

  for (const [index, line] of lines.entries()) {
    const lineLength = line.length + 1; // the newline `split` removed

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch?.[1]) {
      // A fence closes only with the same character and at least as many of
      // them, so ```` inside a ``` block does not end it.
      if (fence === undefined) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      offset += lineLength;
      continue;
    }

    const heading = fence === undefined ? HEADING.exec(line) : null;
    if (heading?.[1] && heading[2] !== undefined) {
      close(offset, index);

      const level = heading[1].length;
      headings.length = Math.min(headings.length, level - 1);
      headings[level - 1] = heading[2].trim();
      for (let i = 0; i < headings.length; i++) headings[i] ??= "";

      openHeadings = headings.filter((value) => value !== "");
      startLine = index;
      startOffset = offset;
    }

    offset += lineLength;
  }

  // The trailing newline `split` invented is not part of the document.
  close(Math.min(offset, markdown.length), lines.length);
  return sections;
}

/** One entry in a page's outline: a heading, and where to read it. */
export interface OutlineSection {
  /** The heading itself, or null for content before the first one. */
  readonly heading: string | null;
  /** Nesting level, 0-based. Render as indentation rather than repeating the path. */
  readonly depth: number;
  /** Pass to `extract` as `offset` to read this section. */
  readonly offset: number;
  readonly chars: number;
}

/**
 * Whether an outline is worth navigating by.
 *
 * A page with two sections, or one section holding most of it, produces an
 * outline that is technically correct and useless — "(preamble) 68297c" is
 * not navigation. Measured against real search results, three of twenty-seven
 * pages look like this, so it is worth saying rather than leaving a caller to
 * infer it from a one-entry list.
 */
const MIN_USEFUL_SECTIONS = 3;
const DOMINANT_SECTION_SHARE = 0.5;

/**
 * Whether a document's sections are worth navigating by.
 *
 * Shared by `outline`, which reports it, and `find`, which needs it to tell a
 * caller whether a miss means "no section covered this" or "there was nothing
 * to match against". One predicate over one split, so the two operations can
 * never disagree about the same page.
 */
export function isNavigable(sectionLengths: readonly number[], totalChars: number): boolean {
  const biggest = Math.max(0, ...sectionLengths);
  return (
    sectionLengths.length >= MIN_USEFUL_SECTIONS && (totalChars === 0 || biggest / totalChars < DOMINANT_SECTION_SHARE)
  );
}

/**
 * Describes a document's structure, addressed by the same offsets `extract`
 * takes.
 *
 * Offsets rather than indices deliberately: an index would need a second
 * addressing scheme and a lookup table, where an offset is what the read
 * method already accepts. The outline is self-describing — read a heading,
 * pass its offset back.
 */
export function buildOutline(markdown: string): { sections: OutlineSection[]; navigable: boolean } {
  const sections = splitSections(markdown).map((section) => ({
    heading: section.headings.at(-1) ?? null,
    depth: Math.max(0, section.headings.length - 1),
    offset: section.start,
    chars: section.end - section.start,
  }));

  return {
    sections,
    navigable: isNavigable(
      sections.map((s) => s.chars),
      markdown.length,
    ),
  };
}

/**
 * Returns the window of `markdown` starting at or before `offset`.
 *
 * Offsets are characters because that is what a caller can reason about
 * without learning a cursor scheme, but they snap to section starts so a
 * window never begins mid-sentence. The one exception is a section longer
 * than the whole budget: it cannot be returned whole, so it is cut at a
 * line or word boundary and the offset is honoured exactly. Snapping there
 * would return the same prefix forever.
 */
export function sliceWindow(markdown: string, options: { offset?: number; maxChars: number }): MarkdownWindow {
  const totalChars = markdown.length;
  const maxChars = Math.max(1, options.maxChars);
  const requested = Math.min(Math.max(0, Math.trunc(options.offset ?? 0)), totalChars);

  const sections = splitSections(markdown);
  if (sections.length === 0) {
    return { markdown: markdown.slice(requested), offset: requested, totalChars };
  }

  // The last section beginning at or before the requested offset. A loop
  // rather than findLastIndex, which needs a newer lib target than the rest
  // of this package compiles against.
  let index = 0;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section && section.start <= requested) index = i;
    else break;
  }

  const containing = sections[index];
  if (!containing) return { markdown: "", offset: requested, totalChars };

  // A section that cannot fit whole is served from where the caller asked.
  if (containing.end - containing.start > maxChars) {
    const next = safeCut(markdown, containing.start, requested, maxChars);
    return {
      markdown: markdown.slice(requested, next).trimEnd(),
      offset: requested,
      ...(next < totalChars ? { nextOffset: next } : {}),
      totalChars,
    };
  }

  const start = containing.start;
  let end = start;
  for (let i = index; i < sections.length; i++) {
    const section = sections[i];
    if (!section) break;
    if (section.end - start > maxChars && end > start) break;
    end = section.end;
  }

  return {
    markdown: markdown.slice(start, end).trimEnd(),
    offset: start,
    ...(end < totalChars ? { nextOffset: end } : {}),
    totalChars,
  };
}

/**
 * Where to end a window that has to cut inside a section.
 *
 * Prefers a line boundary that is not inside a fenced code block. Sections
 * never split a fence, but a section longer than the whole budget has to be
 * cut somewhere, and cutting on the last newline reintroduced exactly the
 * failure sections were built to avoid: measured against nodejs.org/api/sqlite
 * at a 500-character budget, 22 of 201 windows ended mid-snippet, handing back
 * truncated code with no closing fence.
 *
 * Fence state is replayed from the start of the section rather than from the
 * window, because a window that begins mid-section does not know whether it
 * begins inside a block.
 *
 * A code block longer than the entire budget still has to be cut inside — no
 * boundary exists — and it is cut at a line so the damage is at least whole
 * lines. Nothing is appended to mark it: an invented ``` would be this system
 * writing code into content the response labels untrusted.
 */
export function safeCut(markdown: string, sectionStart: number, from: number, maxChars: number): number {
  const limit = from + maxChars;
  if (limit >= markdown.length) return markdown.length;

  let fence: string | undefined;
  let offset = sectionStart;
  let lastLineEnd = 0;
  let lastSafeEnd = 0;

  for (const line of markdown.slice(sectionStart).split("\n")) {
    const end = offset + line.length + 1;
    if (end > limit) break;

    const opened = FENCE.exec(line)?.[1];
    if (opened) {
      if (fence === undefined) fence = opened;
      else if (opened[0] === fence[0] && opened.length >= fence.length) fence = undefined;
    }

    if (end > from) {
      lastLineEnd = end;
      if (fence === undefined) lastSafeEnd = end;
    }
    offset = end;
  }

  // A boundary outside a fence wins even when it wastes most of the budget.
  // A short window costs one more round trip against a cache that answers in
  // a millisecond; a window ending mid-snippet costs the reader the snippet.
  if (lastSafeEnd > from) return lastSafeEnd;

  // Nothing safe exists, so this window is inside a block bigger than the
  // whole budget. Cut at a line, so the damage is whole lines.
  if (lastLineEnd > from) return lastLineEnd;

  const slice = markdown.slice(from, limit);
  const space = slice.lastIndexOf(" ");
  return space > maxChars / 2 ? from + space : limit;
}

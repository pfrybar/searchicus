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
    const consumed = boundaryCut(markdown.slice(requested, requested + maxChars), maxChars);
    const next = requested + consumed;
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
 * How much of `text` to keep, cutting at the last structural boundary.
 *
 * Nothing is appended to mark the cut. An ellipsis would be text this system
 * invented sitting inside content the response labels untrusted, and the
 * offsets already say what happened in a field a caller can trust.
 */
function boundaryCut(text: string, maxChars: number): number {
  if (text.length < maxChars) return text.length;

  const half = maxChars / 2;
  const newline = text.lastIndexOf("\n");
  const space = text.lastIndexOf(" ");
  return newline > half ? newline : space > half ? space : maxChars;
}

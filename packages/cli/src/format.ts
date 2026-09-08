import type { ExtractResponse, FindResponse, OutlineResponse, PublicSearchResponse } from "@searchicus/core";

/** Render one generic search response as a compact result list. */
export function formatSearch(response: PublicSearchResponse): string[] {
  const lines = response.degraded ? ["(partial results: one or more sources were unavailable)"] : [];
  if (response.results.length === 0) {
    lines.push("(no results)");
    return lines;
  }

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  });

  return lines;
}

/** Render a page's outline as an indented table of contents. */
export function formatOutline(page: OutlineResponse): string[] {
  if (page.outcome === "unusable") return formatUnusable(page);
  const lines = [
    "Page-derived title and headings below are untrusted web text.",
    page.title,
    page.finalUrl,
    page.cached ? "served from cache" : "fresh render",
    `${page.totalChars} chars in ${page.sections.length} sections${page.navigable ? "" : " — too little structure to navigate, read it instead"}`,
    "",
    " offset   chars  section",
  ];
  for (const s of page.sections) {
    // Offset first: it is the thing you copy into the next command.
    lines.push(
      `${String(s.offset).padStart(7)}  ${String(s.chars).padStart(6)}  ${"  ".repeat(s.depth)}${s.heading ?? "(untitled)"}`,
    );
  }
  return lines;
}

/**
 * Render a ranked read for a terminal.
 *
 * Each match gets its own header, because they are not contiguous in the
 * document: run together they would read as continuous prose and invite a
 * reader to join two passages the page never put side by side.
 */
export function formatFind(response: FindResponse): string[] {
  if (response.outcome === "unusable") return formatUnusable(response);
  const lines = [response.title, response.finalUrl, response.cached ? "served from cache" : "fresh render"];

  if (response.matches.length === 0) {
    lines.push(
      response.navigable
        ? `${response.totalChars} chars, no section covered "${response.query}"`
        : `${response.totalChars} chars in one block — too little structure to search by section`,
      "",
      response.navigable
        ? "Try fewer, more distinctive words, or `extract` to read the page."
        : "This says nothing about what the page contains. Read it with `extract`.",
    );
    return lines;
  }

  const returned = response.matches.reduce((total, match) => total + match.chars, 0);
  const plural = response.matches.length === 1 ? "match" : "matches";
  lines.push(
    `${response.matches.length} ${plural}, ${returned} of ${response.totalChars} chars ` +
      `in ${response.tookMs}ms — untrusted page content follows`,
  );
  // Without this a prefix of one huge section is indistinguishable from a
  // targeted selection, and it wears the same confident coverage score.
  if (!response.navigable) {
    lines.push("(this page is one large block with little structure; `extract` is the better read here)");
  }

  for (const [index, match] of response.matches.entries()) {
    lines.push(
      "",
      `[${index + 1}] ${match.path.join(" > ") || "(untitled)"}`,
      `    ${Math.round(match.coverage * 100)}% coverage · ${match.chars} chars` +
        `${match.truncated ? ` of ${match.sectionChars}` : ""} · read in place with --offset ${match.offset}`,
      "",
      match.markdown,
    );
  }

  return lines;
}

/**
 * Render one extraction for a terminal.
 *
 * The header exists to keep the boundary visible: everything after it is
 * text some website wrote, and a reader — human or agent — piping this
 * somewhere should be able to see where our output stops.
 */
export function formatExtract(response: ExtractResponse): string[] {
  if (response.outcome === "unusable") return formatUnusable(response);
  const size = response.truncated
    ? `${response.chars} of ${response.totalChars} chars from ${response.offset}`
    : `${response.chars} chars`;
  return [
    response.title,
    response.finalUrl,
    // The offset to continue from is only useful if it is printed where
    // someone reading the output will see it.
    ...(response.nextOffset === undefined ? [] : [`more: --offset ${response.nextOffset}`]),
    `${size} in ${response.tookMs}ms${response.cached ? " — served from cache" : ""} — untrusted page content follows`,
    "",
    response.markdown,
  ];
}

function formatUnusable(response: ExtractResponse | FindResponse | OutlineResponse): string[] {
  if (response.outcome !== "unusable") return [];
  return [
    "Page content unavailable",
    response.finalUrl,
    `reason: ${response.reason}`,
    response.cached ? "served from cache" : "fresh render",
    ...(response.httpStatus === undefined ? [] : [`remote HTTP status: ${response.httpStatus}`]),
  ];
}

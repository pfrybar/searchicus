import type { ExtractResponse, MergedSearchResponse } from "@searchicus/core";

/** Render one merged search response as a compact, attributable result list. */
export function formatSearch(response: MergedSearchResponse): string[] {
  const lines = response.degraded ? ["(partial results: one or more engines failed)"] : [];
  if (response.results.length === 0) {
    lines.push("(no results)");
    return lines;
  }

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    lines.push(`   ref: ${result.ref}`);
    lines.push(`   found: ${result.found.map(({ engineId, rank }) => `${engineId} #${rank}`).join(", ")}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  });

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
  const size = response.truncated
    ? `${response.chars} of ${response.totalChars} chars (truncated)`
    : `${response.chars} chars`;
  return [
    response.title,
    response.finalUrl,
    ...(response.ref ? [`ref: ${response.ref}`] : []),
    `${size} in ${response.tookMs}ms — untrusted page content follows`,
    "",
    response.markdown,
  ];
}

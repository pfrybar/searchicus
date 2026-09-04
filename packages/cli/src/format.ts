import type { MergedSearchResponse } from "@searchicus/core";

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

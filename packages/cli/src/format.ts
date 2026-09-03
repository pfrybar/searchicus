import type { EngineSearchOutcome } from "@searchicus/core";

/** Render one engine's search outcome as human-readable lines. */
export function formatOutcome(outcome: EngineSearchOutcome): string[] {
  const lines = [`== ${outcome.engineId} ==`];

  if (!outcome.ok) {
    lines.push(`  error: ${outcome.error}`);
    return lines;
  }

  if (outcome.response.results.length === 0) {
    lines.push("  (no results)");
    return lines;
  }

  outcome.response.results.forEach((result, i) => {
    lines.push(`  ${i + 1}. ${result.title}`);
    lines.push(`     ${result.url}`);
    if (result.snippet) lines.push(`     ${result.snippet}`);
  });

  return lines;
}

import { describe, expect, it } from "vitest";
import { formatOutcome } from "./format.js";

describe("formatOutcome", () => {
  it("lists each result under the engine heading", () => {
    const lines = formatOutcome({
      engineId: "mock",
      ok: true,
      response: {
        engine: "mock",
        query: { query: "cats" },
        tookMs: 1,
        results: [{ title: "Cats 101", url: "https://example.com/cats", source: "mock", snippet: "All about cats" }],
      },
    });

    expect(lines[0]).toBe("== mock ==");
    expect(lines).toContain("  1. Cats 101");
    expect(lines).toContain("     https://example.com/cats");
    expect(lines).toContain("     All about cats");
  });

  it("notes when an engine returned no results", () => {
    const lines = formatOutcome({
      engineId: "mock",
      ok: true,
      response: { engine: "mock", query: { query: "cats" }, tookMs: 1, results: [] },
    });

    expect(lines).toContain("  (no results)");
  });

  it("surfaces a failed engine's error instead of results", () => {
    const lines = formatOutcome({ engineId: "broken", ok: false, error: "boom" });

    expect(lines).toEqual(["== broken ==", "  error: boom"]);
  });
});

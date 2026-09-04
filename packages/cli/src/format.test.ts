import { SearchEngineRegistry } from "@searchicus/core";
import { describe, expect, it, vi } from "vitest";
import { createProgram, parseLimit } from "./index.js";
import { formatOutcome } from "./format.js";

describe("formatOutcome", () => {
  it("lists each result under the engine heading", () => {
    const lines = formatOutcome({
      engineId: "test",
      ok: true,
      response: {
        engine: "test",
        query: { query: "cats" },
        tookMs: 1,
        results: [{ title: "Cats 101", url: "https://example.com/cats", source: "test", snippet: "All about cats" }],
      },
    });

    expect(lines[0]).toBe("== test ==");
    expect(lines).toContain("  1. Cats 101");
    expect(lines).toContain("     https://example.com/cats");
    expect(lines).toContain("     All about cats");
  });

  it("notes when an engine returned no results", () => {
    const lines = formatOutcome({
      engineId: "test",
      ok: true,
      response: { engine: "test", query: { query: "cats" }, tookMs: 1, results: [] },
    });

    expect(lines).toContain("  (no results)");
  });

  it("surfaces a failed engine's error instead of results", () => {
    const lines = formatOutcome({ engineId: "broken", ok: false, error: "boom" });

    expect(lines).toEqual(["== broken ==", "  error: boom"]);
  });
});

describe("CLI argument handling", () => {
  it("accepts only limits allowed by the shared query schema", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(100);
    expect(() => parseLimit("2results")).toThrow();
    expect(() => parseLimit("0")).toThrow();
    expect(() => parseLimit("101")).toThrow();
  });

  it("normalizes a valid query before searching", async () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = createProgram(
      new SearchEngineRegistry({ throttle: null }).register({
        id: "test",
        name: "Test Search Engine",
        search: async (query) => ({ query, results: [], engine: "test", tookMs: 0 }),
      }),
    );

    await program.parseAsync(["node", "searchicus", "search", "  cats  ", "--json"]);

    const outcomes = JSON.parse(write.mock.calls[0]?.[0] as string);
    expect(outcomes[0].response.query.query).toBe("cats");
    write.mockRestore();
  });
});

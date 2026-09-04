import { SearchEngineRegistry } from "@searchicus/core";
import { describe, expect, it, vi } from "vitest";
import { formatSearch } from "./format.js";
import { createProgram, parseLimit } from "./index.js";

describe("formatSearch", () => {
  it("lists ranked results with their refs and attribution", () => {
    const lines = formatSearch({
      searchId: "abc123",
      query: { query: "cats" },
      tookMs: 1,
      degraded: false,
      results: [
        {
          ref: "abc123-1",
          title: "Cats 101",
          url: "https://example.com/cats",
          snippet: "All about cats",
          score: 0.1,
          bestSource: "test",
          found: [{ engineId: "test", rank: 1 }],
          families: ["test"],
        },
      ],
    });

    expect(lines).toContain("1. Cats 101");
    expect(lines).toContain("   https://example.com/cats");
    expect(lines).toContain("   ref: abc123-1");
    expect(lines).toContain("   found: test #1");
    expect(lines).toContain("   All about cats");
  });

  it("marks partial results without exposing failed engines", () => {
    const lines = formatSearch({ searchId: "abc", query: { query: "cats" }, tookMs: 1, degraded: true, results: [] });

    expect(lines).toEqual(["(partial results: one or more engines failed)", "(no results)"]);
  });
});

describe("CLI argument handling", () => {
  it("accepts only final result limits allowed by the shared request schema", () => {
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

    const response = JSON.parse(write.mock.calls[0]?.[0] as string);
    expect(response.query.query).toBe("cats");
    expect(response).not.toHaveProperty("outcomes");
    write.mockRestore();
  });

  it("rejects duplicate engine selections with the shared request schema", async () => {
    const program = createProgram(
      new SearchEngineRegistry({ throttle: null }).register({
        id: "test",
        name: "Test Search Engine",
        search: async (query) => ({ query, results: [], engine: "test", tookMs: 0 }),
      }),
    );

    await expect(
      program.parseAsync(["node", "searchicus", "search", "cats", "--engine", "test", "test"]),
    ).rejects.toThrow(/engines must not contain duplicates/);
  });
});

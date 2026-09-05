import { DEFAULT_EXTRACT_CONFIG, ExtractionService, SearchEngineRegistry } from "@searchicus/core";
import { describe, expect, it, vi } from "vitest";
import { formatExtract, formatSearch } from "./format.js";
import { createProgram, parseLimit, parseMaxChars } from "./index.js";

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
    expect(parseLimit("20")).toBe(20);
    expect(() => parseLimit("2results")).toThrow();
    expect(() => parseLimit("0")).toThrow();
    expect(() => parseLimit("21")).toThrow();
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

describe("formatExtract", () => {
  it("labels the boundary before the page's own text begins", () => {
    const lines = formatExtract({
      url: "https://example.com/a",
      finalUrl: "https://www.example.com/a",
      ref: "abc123-1",
      title: "An article",
      markdown: "# An article\n\nSome prose.",
      truncated: false,
      chars: 25,
      tookMs: 812,
      untrusted: true,
    });

    expect(lines[0]).toBe("An article");
    expect(lines[1]).toBe("https://www.example.com/a");
    expect(lines[2]).toBe("ref: abc123-1");
    // Piped into a terminal or an agent, the reader has to be able to see
    // where our output stops and a stranger's website starts.
    expect(lines[3]).toBe("25 chars in 812ms — untrusted page content follows");
    expect(lines.at(-1)).toBe("# An article\n\nSome prose.");
  });

  it("says when content was cut short, and omits a ref it never had", () => {
    const lines = formatExtract({
      url: "https://example.com/a",
      finalUrl: "https://example.com/a",
      title: "Long",
      markdown: "x",
      truncated: true,
      chars: 1,
      tookMs: 5,
      untrusted: true,
    });

    expect(lines.join("\n")).toContain("(truncated)");
    expect(lines.join("\n")).not.toContain("ref:");
  });
});

describe("parseMaxChars", () => {
  it("accepts a budget inside the shared bounds and rejects anything else", () => {
    expect(parseMaxChars("500")).toBe(500);
    expect(() => parseMaxChars("0")).toThrow();
    expect(() => parseMaxChars("1000000")).toThrow();
    expect(() => parseMaxChars("lots")).toThrow();
  });
});

describe("extract command", () => {
  it("prints the extracted Markdown", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const extraction = new ExtractionService({
      config: { ...DEFAULT_EXTRACT_CONFIG, enabled: true },
      renderer: {
        render: async () => ({ finalUrl: "https://example.com/a", html: "<html></html>", redirects: 0 }),
        close: async () => undefined,
      },
      parse: async () => ({ title: "An article", markdown: "Some prose.", wordCount: 2 }),
      lookup: async () => ["93.184.216.34"],
    });

    await createProgram(new SearchEngineRegistry({ throttle: null }), extraction).parseAsync([
      "node",
      "searchicus",
      "extract",
      "https://example.com/a",
    ]);

    expect(log.mock.calls.flat().join("\n")).toContain("Some prose.");
    log.mockRestore();
  });

  it("reports that extraction is switched off rather than failing obscurely", async () => {
    await expect(
      createProgram(new SearchEngineRegistry({ throttle: null })).parseAsync([
        "node",
        "searchicus",
        "extract",
        "https://example.com/a",
      ]),
    ).rejects.toThrow(/SEARCHICUS_EXTRACT_ENABLED/);
  });
});

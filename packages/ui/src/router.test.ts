import { describe, expect, it } from "vitest";
import { href, parseHash } from "./router";

describe("parseHash", () => {
  it("reads the routes the UI knows about", () => {
    expect(parseHash("#/")).toEqual({ name: "search" });
    expect(parseHash("")).toEqual({ name: "search" });
    expect(parseHash("#/metrics")).toEqual({ name: "metrics" });
    expect(parseHash("#/searches")).toEqual({ name: "searches" });
    expect(parseHash("#/searches/")).toEqual({ name: "searches" });
    expect(parseHash("#/searches/00m2ebw9mbyib")).toEqual({ name: "search-detail", searchId: "00m2ebw9mbyib" });
  });

  it("decodes a search id that needed escaping", () => {
    expect(parseHash("#/searches/a%20b")).toEqual({ name: "search-detail", searchId: "a b" });
  });

  it("survives a hash nobody meant to type", () => {
    // decodeURIComponent throws on a stray percent or a truncated escape, and
    // this runs during first render and on every hashchange — so these took
    // the whole page down rather than showing "no such search".
    for (const hash of ["#/searches/%", "#/searches/%E0%A4%A", "#/searches/%zz", "#/searches/100%"]) {
      expect(() => parseHash(hash), hash).not.toThrow();
      expect(parseHash(hash).name, hash).toBe("search-detail");
    }
  });

  it("reads the query a search URL carries", () => {
    expect(parseHash("#/?q=cats")).toEqual({ name: "search", query: "cats" });
    expect(parseHash("#/?q=my+query")).toEqual({ name: "search", query: "my query" });
    expect(parseHash("#/?q=a%20b&other=1")).toEqual({ name: "search", query: "a b" });
    // A question mark inside the value: split at the first one only, or the
    // rest of the query silently disappears.
    expect(parseHash("#/?q=what+is+this%3F+really")).toEqual({ name: "search", query: "what is this? really" });
  });

  it("leaves a query off the route when there is nothing to carry", () => {
    // Absent rather than undefined, so a bare `#/` stays the route it was.
    expect(parseHash("#/?q=")).toEqual({ name: "search" });
    expect(parseHash("#/?q=%20%20")).toEqual({ name: "search" });
    expect(parseHash("#/?other=1")).toEqual({ name: "search" });
  });

  it("does not mistake a query for a path", () => {
    expect(parseHash("#/metrics?q=cats")).toEqual({ name: "metrics" });
    expect(parseHash("#/searches/abc?q=cats")).toEqual({ name: "search-detail", searchId: "abc" });
  });

  it("survives a query nobody meant to type", () => {
    // The same hazard decodeSegment exists for, one level up: this runs on
    // first render and on every hashchange.
    for (const hash of ["#/?q=%", "#/?q=%E0%A4%A", "#/?q=%zz", "#/?q=100%"]) {
      expect(() => parseHash(hash), hash).not.toThrow();
      expect(parseHash(hash).name, hash).toBe("search");
    }
  });

  it("round-trips through href", () => {
    const route = { name: "search-detail", searchId: "abc 123" } as const;
    expect(parseHash(href(route))).toEqual(route);

    const query = { name: "search", query: "sqlite wal & checkpoints" } as const;
    expect(href(query)).toBe("#/?q=sqlite+wal+%26+checkpoints");
    expect(parseHash(href(query))).toEqual(query);
    expect(href({ name: "search" })).toBe("#/");
  });
});

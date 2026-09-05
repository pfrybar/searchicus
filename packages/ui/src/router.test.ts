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

  it("round-trips through href", () => {
    const route = { name: "search-detail", searchId: "abc 123" } as const;
    expect(parseHash(href(route))).toEqual(route);
  });
});

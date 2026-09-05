import { describe, expect, it } from "vitest";
import { PageCache, type CachedPage } from "./page-cache.js";

function page(markdown: string): CachedPage {
  return { finalUrl: "https://example.test/a", redirects: 0, title: "A", markdown, wordCount: 1 };
}

const options = { ttlMs: 1000, maxEntries: 3, maxChars: 100 };

describe("PageCache", () => {
  it("returns what it was given, until it does not", () => {
    const cache = new PageCache(options);
    cache.set("a", page("hello"));
    expect(cache.get("a")?.markdown).toBe("hello");
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stops serving an entry once its time is up", () => {
    let now = 0;
    const cache = new PageCache({ ...options, now: () => now });
    cache.set("a", page("hello"));

    now = 999;
    expect(cache.get("a")).toBeDefined();
    now = 1001;
    expect(cache.get("a")).toBeUndefined();
    // And it is gone, not merely hidden.
    expect(cache.size).toBe(0);
    expect(cache.chars).toBe(0);
  });

  it("evicts least recently used first, not least recently stored", () => {
    const cache = new PageCache(options);
    cache.set("a", page("aaa"));
    cache.set("b", page("bbb"));
    cache.set("c", page("ccc"));

    cache.get("a"); // "a" is now the freshest
    cache.set("d", page("ddd"));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("d")).toBeDefined();
  });

  it("holds a total size, not just a count", () => {
    // An entry cap alone treats an 80,000-character page as it treats a
    // 150-character one.
    const cache = new PageCache({ ...options, maxEntries: 100 });
    cache.set("a", page("x".repeat(60)));
    cache.set("b", page("y".repeat(60)));

    expect(cache.chars).toBeLessThanOrEqual(100);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
  });

  it("declines a page too large to hold rather than evicting everything for it", () => {
    const cache = new PageCache(options);
    cache.set("keep", page("small"));
    cache.set("huge", page("x".repeat(200)));

    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("keep")?.markdown).toBe("small");
  });

  it("keeps its accounting straight when a key is replaced", () => {
    const cache = new PageCache(options);
    cache.set("a", page("x".repeat(50)));
    cache.set("a", page("y".repeat(10)));

    expect(cache.size).toBe(1);
    expect(cache.chars).toBe(10);
  });

  it("clears", () => {
    const cache = new PageCache(options);
    cache.set("a", page("hello"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.chars).toBe(0);
  });
});

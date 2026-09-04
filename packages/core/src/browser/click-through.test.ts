import { describe, expect, it, vi } from "vitest";
import { chooseClickThroughIndex, clickThroughResult } from "./click-through.js";

function fakePage(popup?: { close: () => Promise<void> }) {
  const events: string[] = [];
  return {
    events,
    page: {
      waitForEvent: async (event: string) => {
        events.push(event);
        return popup;
      },
    },
  };
}

function fakeResults(count: number, linkedRanks: ReadonlySet<number> = new Set([0, 1, 2, 3, 4])) {
  const clicks: number[] = [];
  const clickOptions: unknown[] = [];
  const linkSelectors: string[] = [];
  return {
    clicks,
    clickOptions,
    linkSelectors,
    locator: {
      count: async () => count,
      nth: (index: number) => ({
        locator: (selector: string) => {
          linkSelectors.push(selector);
          return {
            first: () => ({
              count: async () => (linkedRanks.has(index) ? 1 : 0),
              click: async (options: unknown) => {
                clicks.push(index);
                clickOptions.push(options);
              },
            }),
          };
        },
      }),
    },
  };
}

describe("chooseClickThroughIndex", () => {
  it("weights choices toward the first result", () => {
    expect(chooseClickThroughIndex(5, () => 0)).toBe(0);
    expect(chooseClickThroughIndex(5, () => 0.45)).toBe(1);
    expect(chooseClickThroughIndex(5, () => 0.71)).toBe(2);
    expect(chooseClickThroughIndex(5, () => 0.99)).toBe(4);
  });

  it("only chooses among result ranks that exist", () => {
    expect(chooseClickThroughIndex(0)).toBeUndefined();
    expect(chooseClickThroughIndex(2, () => 0.99)).toBe(1);
  });
});

describe("clickThroughResult", () => {
  it("does not click when the random draw falls outside the configured rate", async () => {
    const { page } = fakePage();
    const { locator, clicks } = fakeResults(5);

    await expect(
      clickThroughResult(page as never, locator as never, undefined, { rate: 0.4, random: () => 0.4 }),
    ).resolves.toBeUndefined();

    expect(clicks).toEqual([]);
  });

  it("clicks a weighted organic result and closes its popup", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let closed = false;
      const { page, events } = fakePage({ close: async () => void (closed = true) });
      const { locator, clicks, clickOptions, linkSelectors } = fakeResults(5);
      const draws = [0, 0.5]; // Click, then choose the second-ranked result.
      const clickThrough = clickThroughResult(page as never, locator as never, controller.signal, {
        rate: 0.4,
        random: () => draws.shift() ?? 0,
      });

      await vi.runAllTimersAsync();
      await expect(clickThrough).resolves.toBeUndefined();

      expect(events).toEqual(["popup"]);
      expect(clicks).toEqual([1]);
      expect(clickOptions).toEqual([{ timeout: 5_000, signal: controller.signal }]);
      expect(linkSelectors).toEqual(["h2 a"]);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks an engine's own link selector for the destination", async () => {
    // Result markup is engine-specific: Brave has no heading element at all,
    // so a helper hardcoded to `h2 a` would silently never click through.
    vi.useFakeTimers();
    try {
      const { page } = fakePage();
      const { locator, clicks, linkSelectors } = fakeResults(5);
      const clickThrough = clickThroughResult(page as never, locator as never, undefined, {
        rate: 1,
        random: () => 0,
        linkSelector: "a:has(div.title)",
      });

      await vi.runAllTimersAsync();
      await expect(clickThrough).resolves.toBeUndefined();

      expect(linkSelectors).toEqual(["a:has(div.title)"]);
      expect(clicks).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not click a result without a linked heading", async () => {
    const { page } = fakePage();
    const { locator, clicks } = fakeResults(1, new Set());

    await expect(
      clickThroughResult(page as never, locator as never, undefined, { rate: 1, random: () => 0 }),
    ).resolves.toBeUndefined();

    expect(clicks).toEqual([]);
  });

  it("settles without clicking when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { page } = fakePage();
    const { locator, clicks } = fakeResults(1);

    await expect(
      clickThroughResult(page as never, locator as never, controller.signal, { rate: 1 }),
    ).resolves.toBeUndefined();

    expect(clicks).toEqual([]);
  });

  it("settles when the result locator fails", async () => {
    const { page } = fakePage();
    const locator = { count: () => Promise.reject(new Error("page closed")) };

    await expect(clickThroughResult(page as never, locator as never, undefined, { rate: 1 })).resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { chooseClickThroughIndex, clickThroughResult } from "./click-through.js";

function fakeResults(count: number, linkedRanks: ReadonlySet<number> = new Set([0, 1, 2, 3, 4])) {
  const clicks: number[] = [];
  const clickOptions: unknown[] = [];
  return {
    clicks,
    clickOptions,
    locator: {
      count: async () => count,
      nth: (index: number) => ({
        locator: () => ({
          first: () => ({
            count: async () => (linkedRanks.has(index) ? 1 : 0),
            click: async (options: unknown) => {
              clicks.push(index);
              clickOptions.push(options);
            },
          }),
        }),
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
    const { locator, clicks } = fakeResults(5);

    await expect(
      clickThroughResult(locator as never, undefined, { rate: 0.4, random: () => 0.4 }),
    ).resolves.toBeUndefined();

    expect(clicks).toEqual([]);
  });

  it("clicks a weighted organic result when selected", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { locator, clicks, clickOptions } = fakeResults(5);
      const draws = [0, 0.5]; // Click, then choose the second-ranked result.
      const clickThrough = clickThroughResult(locator as never, controller.signal, {
        rate: 0.4,
        random: () => draws.shift() ?? 0,
      });

      await vi.runAllTimersAsync();
      await expect(clickThrough).resolves.toBeUndefined();

      expect(clicks).toEqual([1]);
      expect(clickOptions).toEqual([{ timeout: 5_000, signal: controller.signal }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not click a result without a linked heading", async () => {
    const { locator, clicks } = fakeResults(1, new Set());

    await expect(
      clickThroughResult(locator as never, undefined, { rate: 1, random: () => 0 }),
    ).resolves.toBeUndefined();

    expect(clicks).toEqual([]);
  });

  it("settles without clicking when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { locator, clicks } = fakeResults(1);

    await expect(clickThroughResult(locator as never, controller.signal, { rate: 1 })).resolves.toBeUndefined();

    expect(clicks).toEqual([]);
  });

  it("settles when the result locator fails", async () => {
    const locator = { count: () => Promise.reject(new Error("page closed")) };

    await expect(clickThroughResult(locator as never, undefined, { rate: 1 })).resolves.toBeUndefined();
  });
});

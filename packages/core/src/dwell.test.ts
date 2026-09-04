import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDwell, searchDwell } from "./dwell.js";

/**
 * A dwell is decoration. The contract that matters is that it *always*
 * settles and *never* rejects: the registry releases the browser lease when
 * `SearchSession.completed` settles, so a dwell that hangs or throws leaks a
 * page into a browser meant to run for days.
 */

/**
 * A dwell deliberately spends 5-10 seconds of wall time, so these run on
 * fake timers: waiting it out would be slow and would make every assertion
 * hostage to the random pause lengths.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts a dwell, fast-forwards every pause inside it, and returns it. */
async function settle(dwell: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  return dwell;
}

function fakePage(overrides: { wheel?: () => Promise<void> } = {}) {
  const wheels: [number, number][] = [];
  return {
    wheels,
    page: {
      mouse: {
        wheel: async (x: number, y: number) => {
          wheels.push([x, y]);
          await overrides.wheel?.();
        },
      },
    },
  };
}

function fakeResults(count: number, overrides: { hover?: () => Promise<void> } = {}) {
  const hovered: number[] = [];
  return {
    hovered,
    locator: {
      count: async () => count,
      nth: (index: number) => ({
        hover: async () => {
          hovered.push(index);
          await overrides.hover?.();
        },
      }),
    },
  };
}

describe("searchDwell", () => {
  it("scrolls the page and hovers a result", async () => {
    const { page, wheels } = fakePage();
    const { locator, hovered } = fakeResults(5);

    await expect(settle(searchDwell(page as never, locator as never))).resolves.toBeUndefined();

    expect(wheels.length).toBeGreaterThanOrEqual(2);
    expect(hovered.length).toBeGreaterThanOrEqual(1);
    // Every hover must target a result that exists.
    for (const index of hovered) expect(index).toBeLessThan(5);
  });

  it("resolves without hovering when there are no results to hover", async () => {
    const { page } = fakePage();
    const { locator, hovered } = fakeResults(0);

    await expect(settle(searchDwell(page as never, locator as never))).resolves.toBeUndefined();
    expect(hovered).toEqual([]);
  });

  it("resolves when no result locator is given at all", async () => {
    const { page, wheels } = fakePage();

    await expect(settle(searchDwell(page as never))).resolves.toBeUndefined();
    expect(wheels.length).toBeGreaterThanOrEqual(2);
  });

  it("never rejects when the page throws — a dead page must not fail the search", async () => {
    const { page } = fakePage({
      wheel: () => Promise.reject(new Error("Target page, context or browser has been closed")),
    });
    const { locator } = fakeResults(3, { hover: () => Promise.reject(new Error("element is not attached")) });

    await expect(settle(searchDwell(page as never, locator as never))).resolves.toBeUndefined();
  });

  it("never rejects when counting results throws", async () => {
    const { page } = fakePage();
    const locator = {
      count: () => Promise.reject(new Error("page closed")),
      nth: () => ({ hover: async () => undefined }),
    };

    await expect(settle(searchDwell(page as never, locator as never))).resolves.toBeUndefined();
  });

  it("settles early when aborted, without rejecting", async () => {
    const { page, wheels } = fakePage();
    const controller = new AbortController();
    controller.abort();

    await expect(settle(searchDwell(page as never, undefined, controller.signal))).resolves.toBeUndefined();
    // Aborted during the very first settle pause, before any scrolling.
    expect(wheels).toEqual([]);
  });
});

describe("extractDwell", () => {
  it("scrolls and resolves", async () => {
    const { page, wheels } = fakePage();

    await expect(settle(extractDwell(page as never))).resolves.toBeUndefined();
    expect(wheels.length).toBeGreaterThanOrEqual(1);
  });

  it("never rejects when the page throws", async () => {
    const { page } = fakePage({ wheel: () => Promise.reject(new Error("closed")) });

    await expect(settle(extractDwell(page as never))).resolves.toBeUndefined();
  });

  it("settles early when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { page, wheels } = fakePage();

    await expect(settle(extractDwell(page as never, controller.signal))).resolves.toBeUndefined();
    expect(wheels).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { humanPause, humanType, randInt } from "./human.js";
import { ThrottleAbortError } from "../throttle.js";

describe("randInt", () => {
  it("is inclusive of both bounds", () => {
    expect(randInt(5, 5)).toBe(5);
    expect(randInt(0, 3, () => 0)).toBe(0);
    // The largest value random() can return is just under 1.
    expect(randInt(0, 3, () => 0.999999)).toBe(3);
  });

  it("stays within bounds across many draws", () => {
    for (let i = 0; i < 500; i++) {
      const value = randInt(2, 7);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(7);
    }
  });
});

describe("humanPause", () => {
  it("draws from the short band 80% of the time", async () => {
    vi.useFakeTimers();
    try {
      // random() = 0 selects the short branch and its lower bound.
      const pause = humanPause(40, 220, undefined, () => 0);
      await vi.advanceTimersByTimeAsync(40);
      await expect(pause).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a long hesitation in the top 5%", async () => {
    vi.useFakeTimers();
    try {
      // random() = 0.99 selects the 600-1400ms branch; 0.99 then lands near
      // the top of it, so the pause must outlast a 600ms advance.
      const pause = humanPause(40, 220, undefined, () => 0.99);
      let settled = false;
      void pause.then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1400);
      await expect(pause).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects promptly when the signal aborts, rather than waiting it out", async () => {
    const controller = new AbortController();
    const pause = humanPause(5_000, 5_000, controller.signal, () => 0);

    controller.abort();

    await expect(pause).rejects.toBeInstanceOf(ThrottleAbortError);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    await expect(humanPause(1, 1, AbortSignal.abort())).rejects.toBeInstanceOf(ThrottleAbortError);
  });
});

describe("humanType", () => {
  it("types one character at a time, in order", async () => {
    const typed: string[] = [];
    const locator = { pressSequentially: async (char: string) => void typed.push(char) };

    await humanType(locator as never, "cats");

    expect(typed).toEqual(["c", "a", "t", "s"]);
  });

  it("stops typing when aborted mid-word", async () => {
    const typed: string[] = [];
    const controller = new AbortController();
    const locator = {
      pressSequentially: async (char: string) => {
        typed.push(char);
        if (typed.length === 2) controller.abort();
      },
    };

    await expect(humanType(locator as never, "abcdef", controller.signal)).rejects.toBeInstanceOf(ThrottleAbortError);
    expect(typed).toEqual(["a", "b"]);
  });
});

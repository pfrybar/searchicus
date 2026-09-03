import { describe, expect, it } from "vitest";
import { Throttle, ThrottleAbortError, sleep } from "./throttle.js";

/** Milliseconds elapsed while running `fn`. */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

describe("Throttle", () => {
  it("lets the first caller through immediately", async () => {
    const throttle = new Throttle({ minIntervalMs: 500, jitter: 0 });
    expect(await timed(() => throttle.acquire())).toBeLessThan(50);
  });

  it("spaces consecutive callers by the interval", async () => {
    const throttle = new Throttle({ minIntervalMs: 80, jitter: 0 });

    await throttle.acquire();
    const waited = await timed(() => throttle.acquire());

    expect(waited).toBeGreaterThanOrEqual(60);
  });

  it("measures spacing start-to-start, so slow work doesn't extend it", async () => {
    const throttle = new Throttle({ minIntervalMs: 80, jitter: 0 });

    await throttle.acquire();
    await sleep(90); // stand-in for a session that outlives its results
    expect(await timed(() => throttle.acquire())).toBeLessThan(40);
  });

  it("applies jitter within +/- the configured fraction", async () => {
    const low = new Throttle({ minIntervalMs: 100, jitter: 0.5, random: () => 0 });
    await low.acquire();
    const shortWait = await timed(() => low.acquire());

    const high = new Throttle({ minIntervalMs: 100, jitter: 0.5, random: () => 1 });
    await high.acquire();
    const longWait = await timed(() => high.acquire());

    // random()=0 => 100 * (1 - 0.5) = 50ms; random()=1 => 100 * (1 + 0.5) = 150ms
    expect(shortWait).toBeLessThan(100);
    expect(longWait).toBeGreaterThanOrEqual(120);
  });

  it("reserves slots in call order rather than racing for the same instant", async () => {
    const throttle = new Throttle({ minIntervalMs: 40, jitter: 0 });
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await throttle.acquire();
        order.push(i);
      }),
    );

    expect(order).toEqual([0, 1, 2]);
  });

  it("rejects a waiting caller when its signal aborts", async () => {
    const throttle = new Throttle({ minIntervalMs: 5_000, jitter: 0 });
    await throttle.acquire();

    const controller = new AbortController();
    const pending = throttle.acquire(controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ThrottleAbortError);
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const throttle = new Throttle({ minIntervalMs: 5_000, jitter: 0 });
    await throttle.acquire();

    await expect(throttle.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(ThrottleAbortError);
  });

  it("rejects nonsensical options", () => {
    expect(() => new Throttle({ minIntervalMs: -1 })).toThrow(RangeError);
    expect(() => new Throttle({ jitter: 1.5 })).toThrow(RangeError);
  });
});

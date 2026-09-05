import { describe, expect, it } from "vitest";
import { Throttle, ThrottleAbortError, ThrottleOverloadedError, sleep } from "./throttle.js";

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

  it("gives an aborted caller's place back instead of spending its slot", async () => {
    // The bug this pins: reservations used to be taken at request time and
    // kept when the caller gave up, so a burst of abandoned searches pushed
    // the horizon minutes out and every legitimate search in between failed.
    const throttle = new Throttle({ minIntervalMs: 60, jitter: 0 });
    await throttle.acquire();

    const abandoned = Array.from({ length: 20 }, () => {
      const controller = new AbortController();
      const pending = throttle.acquire(controller.signal);
      controller.abort();
      return pending;
    });
    await Promise.allSettled(abandoned);

    expect(throttle.queued).toBe(0);
    // One interval, not twenty-one. The abandoned callers cost nothing.
    expect(await timed(() => throttle.acquire())).toBeLessThan(150);
  });

  it("keeps the queue in arrival order when a waiter in the middle leaves", async () => {
    const throttle = new Throttle({ minIntervalMs: 20, jitter: 0 });
    const order: string[] = [];
    await throttle.acquire();

    const first = throttle.acquire().then(() => void order.push("first"));
    const controller = new AbortController();
    const leaving = throttle.acquire(controller.signal).catch(() => void order.push("left"));
    const last = throttle.acquire().then(() => void order.push("last"));

    controller.abort();
    await Promise.all([first, leaving, last]);

    expect(order).toEqual(["left", "first", "last"]);
  });

  it("refuses a caller outright once the queue is full", async () => {
    // Waiting behind sixty callers is a promise nobody can keep, so the
    // honest answer is an immediate refusal the caller can act on.
    const throttle = new Throttle({ minIntervalMs: 5_000, jitter: 0, maxQueued: 2 });
    await throttle.acquire();

    const controller = new AbortController();
    const waiting = [throttle.acquire(controller.signal), throttle.acquire(controller.signal)];
    for (const pending of waiting) void pending.catch(() => undefined);
    expect(throttle.queued).toBe(2);

    await expect(throttle.acquire()).rejects.toBeInstanceOf(ThrottleOverloadedError);
    await expect(throttle.acquire()).rejects.toThrow(/Too many searches/);

    // The refusal is not permanent: when the waiters leave, the queue reopens.
    controller.abort();
    await Promise.allSettled(waiting);
    expect(throttle.queued).toBe(0);

    const readmitted = throttle.acquire(AbortSignal.timeout(10_000));
    void readmitted.catch(() => undefined);
    expect(throttle.queued).toBe(1);
  });

  it("rejects nonsensical options", () => {
    expect(() => new Throttle({ minIntervalMs: -1 })).toThrow(RangeError);
    expect(() => new Throttle({ jitter: 1.5 })).toThrow(RangeError);
  });
});

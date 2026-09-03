/** Default spacing between search fan-outs. */
export const DEFAULT_MIN_INTERVAL_MS = 5_000;
/** Default jitter, as a fraction of the interval: 0.3 => 5s becomes 3.5s–6.5s. */
export const DEFAULT_JITTER = 0.3;

export interface ThrottleOptions {
  /** Minimum spacing between the *starts* of consecutive searches. */
  minIntervalMs?: number;
  /** Random spread applied to the interval, as a fraction of it (0 disables). */
  jitter?: number;
  /** Injectable clock/RNG, so tests don't depend on wall time or luck. */
  now?: () => number;
  random?: () => number;
}

export class ThrottleAbortError extends Error {
  constructor(message = "Timed out waiting for a rate-limit slot") {
    super(message);
    this.name = "ThrottleAbortError";
  }
}

/**
 * Spaces out whole search fan-outs. One global throttle gates entry to
 * `SearchEngineRegistry.searchAll()`, so a single incoming search still
 * queries every engine in parallel; it's *consecutive searches* that get
 * spaced apart. Because every fan-out touches every engine, each backend
 * ends up seeing roughly one query per interval without needing its own
 * timer.
 *
 * Spacing is measured start-to-start: a search whose browser session is
 * still running does not hold up the next one. Sessions overlapping is
 * expected — `BrowserSession`'s page cap is what bounds that, not this.
 *
 * Jitter is on by default. A metronomic request every 5.000s is itself a
 * recognizable signature, and the point of the persistent browser profile is
 * to look like ordinary use.
 */
export class Throttle {
  readonly #minIntervalMs: number;
  readonly #jitter: number;
  readonly #now: () => number;
  readonly #random: () => number;
  /** Earliest time the next caller may start. Reserved synchronously. */
  #nextAllowedAt = 0;

  constructor(options: ThrottleOptions = {}) {
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#jitter = options.jitter ?? DEFAULT_JITTER;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;

    if (this.#minIntervalMs < 0) throw new RangeError("minIntervalMs must not be negative");
    if (this.#jitter < 0 || this.#jitter > 1) throw new RangeError("jitter must be between 0 and 1");
  }

  /**
   * Waits until this caller's turn. The slot is reserved synchronously
   * before awaiting, so concurrent callers queue in call order rather than
   * racing for the same instant.
   *
   * Rejects with ThrottleAbortError if `signal` aborts first — the reserved
   * slot is deliberately *not* returned to the pool, since giving it back
   * would let an abandoned search's replacement start immediately and defeat
   * the spacing.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    const startAt = Math.max(this.#now(), this.#nextAllowedAt);
    this.#nextAllowedAt = startAt + this.#nextInterval();

    const waitMs = startAt - this.#now();
    if (waitMs <= 0) {
      signal?.throwIfAborted();
      return;
    }

    return sleep(waitMs, signal);
  }

  /** The configured interval with jitter applied, never negative. */
  #nextInterval(): number {
    if (this.#jitter === 0) return this.#minIntervalMs;
    const spread = (this.#random() * 2 - 1) * this.#jitter;
    return Math.max(0, this.#minIntervalMs * (1 + spread));
  }
}

/** Promise-based setTimeout that rejects (and cleans up) when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ThrottleAbortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new ThrottleAbortError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

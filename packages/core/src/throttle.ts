/** Default spacing between search fan-outs. */
export const DEFAULT_MIN_INTERVAL_MS = 5_000;
/** Default jitter, as a fraction of the interval: 0.3 => 5s becomes 3.5s–6.5s. */
export const DEFAULT_JITTER = 0.3;
/**
 * Default ceiling on callers waiting for a slot.
 *
 * A queue is a promise about the future, and at 5s apart a sixtieth caller is
 * being promised a turn five minutes from now — long past any deadline it
 * still has. Past this point refusing immediately is the honest answer, and
 * the one that lets a caller retry or shed load rather than hold a connection
 * open waiting for a turn it will never take.
 */
export const DEFAULT_MAX_QUEUED = 60;

export interface ThrottleOptions {
  /** Minimum spacing between the *starts* of consecutive searches. */
  minIntervalMs?: number;
  /** Random spread applied to the interval, as a fraction of it (0 disables). */
  jitter?: number;
  /** Callers that may wait at once before further ones are refused outright. */
  maxQueued?: number;
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

/** Raised when joining the queue would not get the caller served in time. */
export class ThrottleOverloadedError extends Error {
  constructor(
    public readonly queued: number,
    /** How long a new arrival would have waited, in milliseconds. */
    public readonly projectedWaitMs: number,
  ) {
    super(`Too many searches are already waiting for a rate-limit slot (${queued}, about ${projectedWaitMs}ms)`);
    this.name = "ThrottleOverloadedError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
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
 *
 * **A slot is spent when it is granted, never when it is requested.** An
 * earlier version reserved a timestamp up front and kept it when the caller
 * gave up, on the reasoning that returning it would let an abandoned search's
 * replacement start immediately. The cost of that was far worse than the
 * problem: abandoned callers pushed the reservation horizon further out every
 * time, so a burst of unauthenticated requests left the throttle handing out
 * slots minutes into the future and every legitimate search in between failed.
 * Callers waiting in line hold no slot, so a caller that leaves the queue
 * costs the next one nothing.
 */
export class Throttle {
  readonly #minIntervalMs: number;
  readonly #jitter: number;
  readonly #maxQueued: number;
  readonly #now: () => number;
  readonly #random: () => number;
  /** Earliest time the next slot may be granted. */
  #nextAllowedAt = 0;
  #waiters: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ThrottleOptions = {}) {
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#jitter = options.jitter ?? DEFAULT_JITTER;
    this.#maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;

    if (this.#minIntervalMs < 0) throw new RangeError("minIntervalMs must not be negative");
    if (this.#jitter < 0 || this.#jitter > 1) throw new RangeError("jitter must be between 0 and 1");
    if (this.#maxQueued < 1) throw new RangeError("maxQueued must be at least 1");
  }

  /** Callers currently waiting for a slot. */
  get queued(): number {
    return this.#waiters.length;
  }

  /**
   * How long a caller arriving now would wait before being served.
   *
   * The time until the next slot, plus one interval for everyone already in
   * front. Jitter is symmetric around the interval, so the interval is the
   * right expectation for each of those; this is a projection rather than a
   * promise, and it is used to refuse work, never to schedule it.
   */
  get projectedWaitMs(): number {
    // Rounded: jitter makes this fractional, and it is an estimate used to
    // refuse work, so sub-millisecond precision is noise in a log line.
    return Math.round(Math.max(0, this.#nextAllowedAt - this.#now()) + this.#waiters.length * this.#minIntervalMs);
  }

  /**
   * Waits until this caller's turn, in arrival order.
   *
   * Rejects with ThrottleAbortError if `signal` aborts first, giving up its
   * place without consuming a slot, and with ThrottleOverloadedError when the
   * queue is already full.
   */
  acquire(signal?: AbortSignal, options: { maxWaitMs?: number } = {}): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ThrottleAbortError());

    // Granted straight away only when nobody is ahead: letting a newcomer
    // overtake a queue would starve whoever has been waiting longest. Note
    // this ignores maxWaitMs, correctly — there is no wait to be too long.
    if (this.#waiters.length === 0 && this.#now() >= this.#nextAllowedAt) {
      this.#spendSlot();
      return Promise.resolve();
    }

    // Admission is a question about time, not about depth. A queue of sixty
    // at five seconds apart is five minutes of work being offered to callers
    // holding a thirty-second deadline: measured, fifty-five of sixty-one
    // admitted callers waited the full deadline to be told no. Refusing on
    // the projected wait tells them at once, and makes the depth cap below a
    // backstop rather than the policy.
    const projected = this.projectedWaitMs;
    const tooLate = options.maxWaitMs !== undefined && projected > options.maxWaitMs;
    if (tooLate || this.#waiters.length >= this.#maxQueued) {
      return Promise.reject(new ThrottleOverloadedError(this.#waiters.length, projected));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      waiter.onAbort = (): void => {
        this.#waiters = this.#waiters.filter((queued) => queued !== waiter);
        reject(new ThrottleAbortError());
        // The head of the queue may have just left; whoever is now first
        // should not wait behind a departed caller's timer.
        this.#schedule();
      };

      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#schedule();
    });
  }

  /** Marks a slot as taken now, and sets when the next one may be. */
  #spendSlot(): void {
    this.#nextAllowedAt = this.#now() + this.#nextInterval();
  }

  /** Arms a single timer for the moment the queue head may proceed. */
  #schedule(): void {
    if (this.#timer !== undefined || this.#waiters.length === 0) return;

    const wait = Math.max(0, this.#nextAllowedAt - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#grantOne();
    }, wait);
  }

  #grantOne(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.#spendSlot();
      waiter.resolve();
    }
    this.#schedule();
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

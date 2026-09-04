import type { BrowserLease, BrowserLeaseHandle, BrowserProvider, SearchContext } from "./context.js";
import { MockSearchEngine } from "./engines/mock.js";
import { BingSearchEngine } from "./engines/bing.js";
import { Throttle, type ThrottleOptions } from "./throttle.js";
import type { SearchEngine, SearchQuery, SearchResponse, SearchSession } from "./types.js";

/** Budget from searchAll() entry to results, including time spent throttled. */
export const DEFAULT_RESULTS_TIMEOUT_MS = 30_000;
/** Hard cap on a session's total life, including work that outlives results. */
export const DEFAULT_SESSION_TIMEOUT_MS = 60_000;

export class UnknownEngineError extends Error {
  constructor(public readonly engineId: string) {
    super(`No search engine registered with id "${engineId}"`);
    this.name = "UnknownEngineError";
  }
}

/** One engine's outcome within a fan-out search. */
export type EngineSearchOutcome =
  { engineId: string; ok: true; response: SearchResponse } | { engineId: string; ok: false; error: string };

export interface SearchEngineRegistryOptions {
  /**
   * Spaces out consecutive search fan-outs. Pass `null` to disable — useful
   * in tests that run several searches back to back, since the default would
   * make the second one wait five seconds.
   */
  throttle?: Throttle | ThrottleOptions | null;
  /** Shared browser, injected so core's main entry never imports Playwright. */
  browser?: BrowserProvider;
  resultsTimeoutMs?: number;
  sessionTimeoutMs?: number;
}

/**
 * Holds the available SearchEngine backends and fans a query out to one or
 * many of them. Every front door (CLI/API/MCP/UI) talks to a registry, never
 * to an engine directly.
 *
 * The registry also owns the two policies that engines shouldn't each
 * reimplement:
 *
 * - **Rate limiting.** One global throttle gates entry to `searchAll()`, so
 *   a single incoming search still hits every engine in parallel while
 *   *consecutive* searches are spaced apart.
 * - **Session lifetime.** Engines may return results before their browser
 *   work is done. The registry tracks those sessions, releases their browser
 *   leases when they settle, swallows their late failures so an unhandled
 *   rejection can't take the process down, and caps how long they may run.
 *
 * Because sessions outlive the call that started them, a process that exits
 * as soon as it has results will kill live browser work. Call `drain()`
 * before exiting (the CLI does) or `close()` on shutdown.
 */
export class SearchEngineRegistry {
  private readonly engines = new Map<string, SearchEngine>();
  readonly #throttle: Throttle | undefined;
  readonly #browser: BrowserProvider | undefined;
  readonly #resultsTimeoutMs: number;
  readonly #sessionTimeoutMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  #closed = false;

  constructor(options: SearchEngineRegistryOptions = {}) {
    const { throttle = {} } = options;
    this.#throttle = throttle === null ? undefined : throttle instanceof Throttle ? throttle : new Throttle(throttle);
    this.#browser = options.browser;
    this.#resultsTimeoutMs = options.resultsTimeoutMs ?? DEFAULT_RESULTS_TIMEOUT_MS;
    this.#sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  }

  /** Register an engine, replacing any previous engine with the same id. */
  register(engine: SearchEngine): this {
    this.engines.set(engine.id, engine);
    return this;
  }

  get(id: string): SearchEngine | undefined {
    return this.engines.get(id);
  }

  has(id: string): boolean {
    return this.engines.has(id);
  }

  list(): SearchEngine[] {
    return [...this.engines.values()];
  }

  /** Number of sessions still doing browser work after returning results. */
  get activeSessions(): number {
    return this.#inFlight.size;
  }

  /**
   * Search one specific engine by id. Throws UnknownEngineError if
   * unregistered. Resolves as soon as results are ready; any browser work
   * the engine continues afterwards is tracked by the registry.
   */
  async search(engineId: string, query: SearchQuery): Promise<SearchResponse> {
    if (!this.engines.has(engineId)) throw new UnknownEngineError(engineId);

    const deadline = Date.now() + this.#resultsTimeoutMs;
    await this.#awaitSlot(deadline);
    return this.#runEngine(engineId, query, deadline);
  }

  /**
   * Fan a query out to multiple engines in parallel (default: every
   * registered engine) and report each one's outcome, including failures,
   * rather than rejecting the whole call when one engine errors.
   *
   * The rate-limit wait happens once, here, for the whole fan-out. If that
   * wait exhausts the results budget, every engine reports a failed outcome
   * — the flip side of gating fan-outs rather than individual queries.
   */
  async searchAll(
    query: SearchQuery,
    engineIds: string[] = this.list().map((engine) => engine.id),
  ): Promise<EngineSearchOutcome[]> {
    const deadline = Date.now() + this.#resultsTimeoutMs;

    try {
      await this.#awaitSlot(deadline);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return engineIds.map((engineId) => ({ engineId, ok: false, error }));
    }

    return Promise.all(
      engineIds.map(async (engineId): Promise<EngineSearchOutcome> => {
        try {
          const response = await this.#runEngine(engineId, query, deadline);
          return { engineId, ok: true, response };
        } catch (err) {
          return { engineId, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  /** Waits for the shared rate-limit slot, bounded by the results deadline. */
  async #awaitSlot(deadline: number): Promise<void> {
    if (!this.#throttle) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for a rate-limit slot");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      await this.#throttle.acquire(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs one engine and resolves with its results. A session that continues
   * past those results is registered for drain() and released when it
   * settles — including when it rejects, so late failures never surface as
   * unhandled rejections.
   */
  async #runEngine(engineId: string, query: SearchQuery, deadline: number): Promise<SearchResponse> {
    if (this.#closed) throw new Error("SearchEngineRegistry is closed");

    const engine = this.engines.get(engineId);
    if (!engine) throw new UnknownEngineError(engineId);

    const controller = new AbortController();
    const scope = new EngineRunScope(this.#browser, controller.signal);
    const sessionTimer = setTimeout(() => controller.abort(), this.#sessionTimeoutMs);

    let outcome: SearchResponse | SearchSession;
    try {
      outcome = await withDeadline(engine.search(query, scope), deadline, `Engine "${engineId}" timed out`);
    } catch (err) {
      clearTimeout(sessionTimer);
      controller.abort();
      await scope.releaseAll();
      throw err;
    }

    // A bare SearchResponse means the engine is done the moment it has
    // results; only a SearchSession keeps the lease open past this point.
    if (!isSearchSession(outcome)) {
      clearTimeout(sessionTimer);
      await scope.releaseAll();
      return outcome;
    }

    this.#track(
      outcome.completed
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(sessionTimer);
          return scope.releaseAll();
        }),
    );

    return outcome.response;
  }

  #track(session: Promise<void>): void {
    const tracked = session.finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
  }

  /**
   * Waits for every session still running after its results were returned.
   * Short-lived processes must call this before exiting or they'll kill live
   * browser work mid-flight.
   */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /** Drains in-flight sessions, then tears down the shared browser. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
    await this.#browser?.close();
  }
}

/**
 * The per-search SearchContext. Tracks every lease an engine takes so the
 * registry can release them all when the session settles, however it settles.
 */
class EngineRunScope implements SearchContext {
  readonly #handles: BrowserLeaseHandle[] = [];

  constructor(
    private readonly browser: BrowserProvider | undefined,
    readonly signal: AbortSignal,
  ) {}

  async acquireBrowser(): Promise<BrowserLease> {
    if (!this.browser) {
      throw new Error(
        "No browser session is configured. Build the registry with createBrowserRegistry() " +
          'from "@searchicus/core/browser", or inject a BrowserSession.',
      );
    }

    const handle = await this.browser.acquire(this.signal);
    this.#handles.push(handle);
    return handle.lease;
  }

  async releaseAll(): Promise<void> {
    await Promise.allSettled(this.#handles.map((handle) => handle.release()));
    this.#handles.length = 0;
  }
}

function isSearchSession(value: SearchResponse | SearchSession): value is SearchSession {
  return "completed" in value;
}

/** Rejects if `promise` hasn't settled by `deadline`. */
async function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), remaining);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Builds the registry every front door (CLI/API/MCP) uses by default.
 *
 * This deliberately has *no* browser attached: attaching one would mean
 * core's main entry imports Playwright, which would drag it into the UI's
 * type graph and into every test run. Surfaces that need a real browser use
 * createBrowserRegistry() from "@searchicus/core/browser" instead.
 *
 * It's a factory, not a shared singleton, so each caller (including tests)
 * can mutate what it gets back without affecting anyone else.
 */
export function createDefaultRegistry(options: SearchEngineRegistryOptions = {}): SearchEngineRegistry {
  return new SearchEngineRegistry(options).register(new MockSearchEngine()).register(new BingSearchEngine());
}

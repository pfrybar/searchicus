import { randomBytes } from "node:crypto";
import { causeOf, createLogger } from "./logger.js";
import type { BrowserLease, BrowserLeaseHandle, BrowserProvider, SearchContext } from "./context.js";
import type { SearchArchive, SearchArchiveRecord } from "./archive.js";
import { BingSearchEngine } from "./engines/bing.js";
import { BraveSearchEngine } from "./engines/brave.js";
import { DuckDuckGoSearchEngine } from "./engines/duckduckgo.js";
import { NoResultsError, OffTargetResultsError, SearchBoxUnavailableError } from "./engines/errors.js";
import { StartpageSearchEngine } from "./engines/startpage.js";
import { rankResults } from "./ranking.js";
import {
  Throttle,
  ThrottleAbortError,
  ThrottleOverloadedError,
  type ThrottleConfig,
  type ThrottleOptions,
} from "./throttle.js";
import type {
  EngineFailureKind,
  EngineSearchOutcome,
  MergedSearchResponse,
  PublicSearchResponse,
  SearchEngine,
  SearchQuery,
  SearchRequest,
  SearchResponse,
  SearchSession,
} from "./types.js";

const log = createLogger("registry");

/** Budget from searchAll() entry to results, including time spent throttled. */
export const DEFAULT_RESULTS_TIMEOUT_MS = 30_000;
/** Hard cap on a session's total life, including work that outlives results. */
export const DEFAULT_SESSION_TIMEOUT_MS = 60_000;
/**
 * Budget kept back for the search itself when deciding whether to queue.
 *
 * A caller admitted with less than this has been let into a queue it cannot
 * be served from, and will spend its whole deadline finding that out.
 * Measured p95 across the shipped engines is about twelve seconds, so that
 * is what a caller needs left when its turn arrives. Deliberately the p95
 * and not the median: refusing someone who would have just made it is a
 * cheaper mistake than accepting someone who will not.
 */
export const DEFAULT_SEARCH_RESERVE_MS = 12_000;

export class UnknownEngineError extends Error {
  constructor(public readonly engineId: string) {
    super(`No search engine registered with id "${engineId}"`);
    this.name = "UnknownEngineError";
  }
}

/** An engine did not produce results before the fan-out's deadline. */
export class EngineTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTimeoutError";
  }
}

/** Work was asked of a registry that is shutting down. */
export class RegistryClosedError extends Error {
  constructor(message = "SearchEngineRegistry is closed") {
    super(message);
    this.name = "RegistryClosedError";
  }
}

/**
 * The search was never admitted: this server is at capacity.
 *
 * Deliberately not an engine failure. The backends were never contacted, so
 * reporting it as one made every engine read as broken on the dashboard built
 * to answer whether an engine is broken — measured at 67% "failure" across
 * all four after a single burst, none of it theirs.
 */
export class SearchOverloadedError extends Error {
  constructor(readonly reason: "queue_full" | "queue_timeout") {
    super(
      reason === "queue_full" ? "Too many searches are already waiting." : "Timed out waiting for a rate-limit slot.",
    );
    this.name = "SearchOverloadedError";
  }
}

/** The caller went away before the search could start. */
export class SearchCancelledError extends Error {
  constructor() {
    super("The search was cancelled.");
    this.name = "SearchCancelledError";
  }
}

/** Counts of work this process turned away, since it started. */
export interface OverloadCounts {
  /** Refused at the door because the queue was already full. */
  refused: number;
  /** Admitted, then gave up waiting before a slot came free. */
  abandoned: number;
}

/** Every selected engine failed before returning a result response. */
export class AllEnginesFailedError extends Error {
  constructor() {
    super("All selected search engines failed");
    this.name = "AllEnginesFailedError";
  }
}

/** What a fan-out is bounded by, as an operator sets it. The `search` slice. */
export interface SearchConfig {
  /** Deadline for a fan-out to produce results. */
  readonly resultsTimeoutMs: number;
  /** Hard cap on browser work that outlives the results it produced. */
  readonly sessionTimeoutMs: number;
  /** Budget kept back for the search itself. See DEFAULT_SEARCH_RESERVE_MS. */
  readonly reserveMs: number;
  /** Spacing between whole fan-outs, which is where rate limiting lives. */
  readonly throttle: ThrottleConfig;
}

export interface SearchEngineRegistryOptions {
  /**
   * Spaces out consecutive search fan-outs. Pass `null` to disable — useful
   * in tests that run several searches back to back, since the default would
   * make the second one wait five seconds.
   */
  throttle?: Throttle | ThrottleOptions | null;
  /** Shared browser, injected so core's main entry never imports Playwright. */
  browser?: BrowserProvider;
  /** Optional asynchronous persistence for complete fan-outs. */
  archive?: SearchArchive | null;
  resultsTimeoutMs?: number;
  sessionTimeoutMs?: number;
  /** Budget kept back for the search itself. See DEFAULT_SEARCH_RESERVE_MS. */
  searchReserveMs?: number;
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
  readonly #searchReserveMs: number;
  readonly #archive: SearchArchive | undefined;
  readonly #inFlightSessions = new Set<Promise<void>>();
  readonly #inFlightArchives = new Set<Promise<void>>();
  readonly #overload: OverloadCounts = { refused: 0, abandoned: 0 };
  #closed = false;

  constructor(options: SearchEngineRegistryOptions = {}) {
    const { throttle = {} } = options;
    this.#throttle = throttle === null ? undefined : throttle instanceof Throttle ? throttle : new Throttle(throttle);
    this.#browser = options.browser;
    this.#archive = options.archive ?? undefined;
    this.#resultsTimeoutMs = options.resultsTimeoutMs ?? DEFAULT_RESULTS_TIMEOUT_MS;
    this.#sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.#searchReserveMs = options.searchReserveMs ?? DEFAULT_SEARCH_RESERVE_MS;
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
    return this.#inFlightSessions.size;
  }

  /** Number of best-effort archive writes still pending. */
  get activeArchives(): number {
    return this.#inFlightArchives.size;
  }

  /**
   * Searches this process turned away, since it started.
   *
   * A process gauge rather than archived history, because these never
   * reached an engine and do not belong in a record of what engines did.
   * They reset on restart, and anything reporting them should say so.
   */
  get overload(): Readonly<OverloadCounts> {
    return { ...this.#overload };
  }

  /**
   * Search one specific engine by id. Throws UnknownEngineError if
   * unregistered. Resolves as soon as results are ready; any browser work
   * the engine continues afterwards is tracked by the registry.
   */
  async searchOne(engineId: string, query: SearchQuery): Promise<SearchResponse> {
    if (!this.engines.has(engineId)) throw new UnknownEngineError(engineId);

    const deadline = Date.now() + this.#resultsTimeoutMs;
    await this.#awaitSlot(deadline);
    return this.#runEngine(engineId, query, deadline);
  }

  /**
   * Searches every registered engine and presents one compact, provider-free
   * list to ordinary callers. Detailed ranking and outcome data stays in the
   * archive record; a partial internal failure only sets `degraded`.
   */
  async search(request: SearchRequest, options: { signal?: AbortSignal } = {}): Promise<PublicSearchResponse> {
    const { limit, ...query } = request;
    const started = Date.now();
    const searchId = createSearchId();
    const engineIds = this.list().map((engine) => engine.id);
    const outcomes = await this.searchAll(query, engineIds, options.signal);
    const tookMs = Date.now() - started;
    const response: MergedSearchResponse | undefined = outcomes.some((outcome) => outcome.ok)
      ? {
          searchId,
          query,
          results: rankResults(query, outcomes, { searchId, engines: this.list(), limit }),
          tookMs,
          degraded: outcomes.some((outcome) => !outcome.ok),
        }
      : undefined;

    this.#queueArchive({
      searchId,
      startedAt: new Date(started).toISOString(),
      query,
      engineIds,
      outcomes,
      response,
      tookMs,
    });

    if (!response) throw new AllEnginesFailedError();
    return {
      query: response.query,
      results: response.results.map(({ title, url, snippet }) => ({ title, url, ...(snippet ? { snippet } : {}) })),
      tookMs: response.tookMs,
      degraded: response.degraded,
    };
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
    signal?: AbortSignal,
  ): Promise<EngineSearchOutcome[]> {
    const started = Date.now();
    const deadline = started + this.#resultsTimeoutMs;

    // Deliberately not wrapped. A search that never got a slot is not every
    // engine having failed: nothing reached a backend, so nothing here
    // describes one — and returning outcomes would archive them, putting this
    // server's own load into the table the dashboard reads to judge engines.
    await this.#awaitSlot(deadline, signal);

    return Promise.all(
      engineIds.map(async (engineId): Promise<EngineSearchOutcome> => {
        const started = Date.now();
        try {
          const response = await this.#runEngine(engineId, query, deadline, signal);
          return { engineId, ok: true, tookMs: Date.now() - started, response };
        } catch (err) {
          return this.#failedOutcome(engineId, Date.now() - started, err);
        }
      }),
    );
  }

  /**
   * Waits for the shared rate-limit slot, bounded by the results deadline and
   * by the caller's own signal.
   *
   * Passing the caller's signal down is what makes a disconnected client
   * cheap: the throttle spends a slot when it grants one, so a caller that
   * leaves the queue hands its place to whoever is behind it.
   */
  async #awaitSlot(deadline: number, signal?: AbortSignal): Promise<void> {
    if (!this.#throttle) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.#overload.abandoned++;
      throw new SearchOverloadedError("queue_timeout");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      // What is left after keeping back enough to actually run the search.
      // Negative when the deadline is already too close, which refuses at the
      // door rather than admitting a caller who cannot finish.
      const maxWaitMs = remaining - this.#searchReserveMs;
      await this.#throttle.acquire(signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, {
        maxWaitMs,
      });
    } catch (err) {
      // Three ways to not get a slot, and they mean different things to the
      // caller: come back later, we were too slow for you, or you left.
      if (err instanceof ThrottleOverloadedError) {
        this.#overload.refused++;
        log.warn("search refused", { queued: err.queued, projectedWaitMs: err.projectedWaitMs, budgetMs: remaining });
        throw new SearchOverloadedError("queue_full");
      }
      if (signal?.aborted) throw new SearchCancelledError();
      this.#overload.abandoned++;
      log.warn("search gave up waiting for a slot", { waitedMs: remaining });
      throw new SearchOverloadedError("queue_timeout");
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
  async #runEngine(
    engineId: string,
    query: SearchQuery,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (this.#closed) throw new RegistryClosedError();

    const engine = this.engines.get(engineId);
    if (!engine) throw new UnknownEngineError(engineId);

    const controller = new AbortController();
    // A caller that has gone away should not leave a browser page working on
    // its behalf for the rest of the session budget.
    const onCallerGone = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerGone, { once: true });
    const scope = new EngineRunScope(this.#browser, controller.signal);

    // Settles when the lease is actually released, which is what the registry
    // tracks — not when the engine says it is finished, which an engine is
    // free never to say.
    const released = deferred();
    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      clearTimeout(sessionTimer);
      signal?.removeEventListener("abort", onCallerGone);
      void scope.releaseAll().then(released.resolve, released.resolve);
    };

    // The session cap is a hard bound, not a request. Aborting the signal
    // asks an engine to stop; an engine that ignores it — or that hands back
    // a `completed` promise which never settles — would otherwise hold its
    // page, this session's slot in drain(), and close() itself open forever.
    // The CLI has no outer timeout at all, so "forever" is literal there.
    const sessionTimer = setTimeout(() => {
      controller.abort();
      finalize();
    }, this.#sessionTimeoutMs);

    let outcome: SearchResponse | SearchSession;
    try {
      outcome = await withDeadline(engine.search(query, scope), deadline, `Engine "${engineId}" timed out`);
    } catch (err) {
      controller.abort();
      finalize();
      await released.promise;
      throw err;
    }

    // A bare SearchResponse means the engine is done the moment it has
    // results; only a SearchSession keeps the lease open past this point.
    if (!isSearchSession(outcome)) {
      finalize();
      await released.promise;
      return outcome;
    }

    // Whichever comes first: the engine finishing, or the cap above.
    outcome.completed.then(finalize, (err: unknown) => {
      // Expected — the results already shipped — but an engine whose page
      // work always fails is worth being able to see.
      log.debug("session ended in failure", { engine: engineId, cause: causeOf(err) });
      finalize();
    });
    this.#track(this.#inFlightSessions, released.promise);

    return outcome.response;
  }

  #failedOutcome(engineId: string, tookMs: number, err: unknown): EngineSearchOutcome {
    const kind = classifyFailure(err);
    // Archived too, but noticing that an engine has started failing should
    // not require SQL.
    log.warn("engine failed", { engine: engineId, kind, tookMs, cause: causeOf(err) });
    return {
      engineId,
      ok: false,
      tookMs: Math.max(0, tookMs),
      errorKind: kind,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  #queueArchive(record: SearchArchiveRecord): void {
    const archive = this.#archive;
    if (!archive) return;

    // Let the result promise resume its caller before synchronous SQLite work
    // begins inside an archive implementation. Archive failures are private
    // best-effort diagnostics, never a change to search success or failure.
    const scheduled = new Promise<void>((resolve) => setImmediate(resolve)).then(() => archive.archive(record));
    this.#track(
      this.#inFlightArchives,
      // Swallowed so archival never changes a search's outcome — but a write
      // that vanishes silently is how an archive quietly stops being one.
      scheduled.catch((err: unknown) => {
        log.warn("archive write failed", { searchId: record.searchId, cause: causeOf(err) });
      }),
    );
  }

  #track(set: Set<Promise<void>>, activity: Promise<void>): void {
    const tracked = activity.finally(() => {
      set.delete(tracked);
    });
    set.add(tracked);
  }

  /**
   * Waits for browser sessions and queued archive writes. Short-lived
   * processes must call this before exiting or they can kill either mid-work.
   */
  async drain(): Promise<void> {
    while (this.#inFlightSessions.size > 0 || this.#inFlightArchives.size > 0) {
      await Promise.allSettled([...this.#inFlightSessions, ...this.#inFlightArchives]);
    }
  }

  /** Drains background work, closes the archive, then tears down the browser. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
    await this.#archive?.close?.().catch(() => undefined);
    await this.#browser?.close();
  }
}

/**
 * The per-search SearchContext. Tracks every lease an engine takes so the
 * registry can release them all when the session settles, however it settles.
 */
class EngineRunScope implements SearchContext {
  readonly #handles: BrowserLeaseHandle[] = [];
  #released = false;

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
    if (this.#released) throw new Error("This search has already finished");

    const handle = await this.browser.acquire(this.signal);

    // Acquisition is asynchronous and a Chromium launch is slow, so this can
    // land after the run was cleaned up — a search that timed out while its
    // browser was still starting. Pushing onto an already-emptied list would
    // leak the page into a browser meant to run for days.
    if (this.#released) {
      await handle.release().catch(() => undefined);
      throw new Error("This search has already finished");
    }

    this.#handles.push(handle);
    return handle.lease;
  }

  async releaseAll(): Promise<void> {
    this.#released = true;
    await Promise.allSettled(this.#handles.map((handle) => handle.release()));
    this.#handles.length = 0;
  }
}

/** A promise with its resolver, for work that is settled from elsewhere. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

function isSearchSession(value: SearchResponse | SearchSession): value is SearchSession {
  return "completed" in value;
}

/** 64-bit base36 id avoids '-' so result refs parse cleanly at the last dash. */
function createSearchId(): string {
  return randomBytes(8).readBigUInt64BE().toString(36).padStart(13, "0");
}

/**
 * Converts raw errors into stable archive metric categories.
 *
 * Everything this package raises itself is matched by type. The two checks
 * that are not are deliberate:
 *
 * - `BrowserUnavailableError` is matched by name because importing it would
 *   pull `browser/session.ts`, and with it Playwright, into core's main entry
 *   — the one thing this package's layout exists to prevent.
 * - Playwright's own timeouts are ordinary Errors carrying "Timeout 30000ms
 *   exceeded", so a message match is the only handle on them. It runs last,
 *   where it can only refine "unknown".
 */
function classifyFailure(err: unknown): EngineFailureKind {
  if (err instanceof NoResultsError) return "no_results";
  if (err instanceof OffTargetResultsError) return "off_target";
  if (err instanceof SearchBoxUnavailableError) return "search_box_unavailable";
  if (err instanceof UnknownEngineError) return "unknown_engine";
  // No branch for being overloaded: a search that was refused a slot never
  // becomes an engine outcome, so it never reaches this function. See
  // SearchOverloadedError.
  if (err instanceof ThrottleAbortError || err instanceof EngineTimeoutError) return "timeout";
  if (err instanceof RegistryClosedError) return "closed";
  if (err instanceof Error && err.name === "BrowserUnavailableError") return "browser_unavailable";

  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout/i.test(message)) return "timeout";
  return "unknown";
}

/** Rejects if `promise` hasn't settled by `deadline`. */
async function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new EngineTimeoutError(message);

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EngineTimeoutError(message)), remaining);
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
  return new SearchEngineRegistry(options)
    .register(new BingSearchEngine())
    .register(new BraveSearchEngine())
    .register(new DuckDuckGoSearchEngine())
    .register(new StartpageSearchEngine());
}

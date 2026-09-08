import { chromium, type BrowserContext, type Page } from "playwright";

import type { BrowserLeaseHandle, BrowserProvider } from "../context.js";
import { causeOf, createLogger } from "../logger.js";
import { resolveProfileDir, type PathsConfig } from "../paths.js";
import { createDefaultRegistry, type SearchEngineRegistry, type SearchEngineRegistryOptions } from "../registry.js";
import { createDefaultSearchArchive, type ArchiveConfig } from "../storage.js";
import { LazyLaunch } from "./lazy-launch.js";
import { findStaleProfileLock, removeStaleProfileLock, type StaleProfileLock } from "./profile-lock.js";
import { buildStealthOptions, resolveChromiumMajor, STEALTH_INIT } from "./stealth.js";

/**
 * Ceiling on simultaneously-open pages. This is a memory safety valve, not
 * the rate policy — the Throttle is the knob to tune. It's set loose enough
 * that it should never be the binding constraint under normal load; if
 * searches start queueing on it, sessions are living longer than expected.
 */
export const DEFAULT_MAX_PAGES = 24;

const log = createLogger("browser");

/** @deprecated Import from the browser-free core entry instead. */
export { DEFAULT_PROFILE_ROOT } from "../paths.js";

export type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export interface BrowserSessionOptions {
  /** Chromium user-data directory. Real, growing, single-writer state on disk. */
  profileDir: string;
  /** Max simultaneously-open pages, a positive integer. See DEFAULT_MAX_PAGES. */
  maxPages?: number;
  /**
   * Remove a profile lock that names another host, then retry the launch.
   *
   * Off unless an operator has declared this deployment the profile's sole
   * writer: the lock is the only evidence that another process might be
   * using it, and deleting it on a hunch corrupts a live profile.
   */
  unlockStaleProfile?: boolean;
  /**
   * Passed straight through to launchPersistentContext.
   *
   * May be a factory, which is resolved on first launch rather than at
   * construction. Some options can only be determined by asking the browser
   * binary about itself (the user agent has to name the version the binary
   * actually is), and doing that eagerly would break the laziness the rest
   * of the design depends on: an engine that never calls `acquireBrowser()`
   * must not cause any browser work at all. The factory also re-runs on a
   * crash relaunch, so a replaced binary is picked up.
   */
  launchOptions?: PersistentContextOptions | (() => PersistentContextOptions | Promise<PersistentContextOptions>);
  /**
   * Script evaluated in every document before page scripts run. Applied
   * inside the launch path, so it is reinstalled automatically when a
   * crashed browser is relaunched — stealth survives recovery for free.
   */
  initScript?: string;
}

export class BrowserUnavailableError extends Error {
  constructor(cause: unknown, staleLock?: StaleProfileLock) {
    const staleLockAdvice = staleLock
      ? ` Chromium's profile lock at "${staleLock.path}" names host "${staleLock.ownerHostname}", ` +
        `not this host "${staleLock.currentHostname}", so it appears stale. If no other searchicus ` +
        `process is using this profile, remove that lock; deployments known to be single-writer can set ` +
        `browser.profileUnlock to retry after removing it automatically.`
      : "";
    super(
      `Could not launch Chromium: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `For an installation failure, install Playwright's browser binary and system libraries ` +
        `(\`npx playwright install chromium\` and \`npx playwright install-deps\`).` +
        staleLockAdvice,
    );
    this.name = "BrowserUnavailableError";
    this.cause = cause;
  }
}

/**
 * A single long-lived Chromium instance with a single persistent context,
 * handing out one page per search.
 *
 * There is deliberately no pool. A pool would buy isolation between
 * concurrent searches, but isolation is the opposite of what's wanted here:
 * sharing one persistent context is what carries cookies, dismissed consent
 * banners, and cache across searches *and across process restarts*, so the
 * automation looks like a browser that has been used before rather than a
 * fresh profile every query.
 *
 * Consequences worth knowing:
 * - **Single point of failure.** A Chromium crash takes down every in-flight
 *   search, where a pool would have lost only a fraction. Handled by
 *   detecting the close and relaunching lazily on the next acquire.
 * - **Single writer.** Two processes cannot share one profile directory, so
 *   each surface (CLI/API/MCP) gets its own — see createDefaultBrowserSession.
 * - **Shared cookies.** Concurrent searches hitting the same backend can race
 *   on that backend's own session cookies. Rare, and usually harmless.
 */
export class BrowserSession implements BrowserProvider {
  readonly #profileDir: string;
  readonly #unlockStaleProfile: boolean;
  readonly #maxPages: number;
  readonly #launchOptions: NonNullable<BrowserSessionOptions["launchOptions"]>;
  readonly #initScript: string | undefined;

  readonly #chromium: LazyLaunch<BrowserContext>;
  #closed = false;
  #openPages = 0;
  #waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  constructor(options: BrowserSessionOptions) {
    this.#profileDir = options.profileDir;
    this.#unlockStaleProfile = options.unlockStaleProfile ?? false;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    // Zero, negative, or NaN makes `#openPages < #maxPages` permanently false,
    // so every acquire would queue forever and the failure would look like a
    // hung browser rather than a bad option. Say so at construction instead.
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1) {
      throw new RangeError(`maxPages must be a positive integer, received ${String(options.maxPages)}`);
    }
    this.#launchOptions = options.launchOptions ?? {};
    this.#initScript = options.initScript;
    this.#chromium = new LazyLaunch(
      () => this.#launchContext(),
      (context) => context.close(),
    );
  }

  /** True once Chromium has actually been launched. Nothing launches until first acquire. */
  get launched(): boolean {
    return this.#chromium.launched;
  }

  /**
   * Leases a page, launching Chromium on first use and waiting for a free
   * page slot if the cap is reached. Rejects if `signal` aborts while
   * waiting, or with BrowserUnavailableError if Chromium can't start.
   */
  async acquire(signal?: AbortSignal): Promise<BrowserLeaseHandle> {
    if (this.#closed) throw new Error("BrowserSession is closed");
    signal?.throwIfAborted();

    await this.#reservePageSlot(signal);

    let context: BrowserContext;
    let page: Page;
    try {
      context = await this.#ensureContext();
      page = await context.newPage();
    } catch (err) {
      this.#releasePageSlot();
      throw err instanceof BrowserUnavailableError ? err : new BrowserUnavailableError(err);
    }

    const pages = [page];
    let released = false;

    return {
      lease: {
        page,
        newPage: async () => {
          if (released) throw new Error("Browser lease has already been released");
          await this.#reservePageSlot(signal);
          try {
            const extra = await context.newPage();
            pages.push(extra);
            return extra;
          } catch (err) {
            this.#releasePageSlot();
            throw err;
          }
        },
      },
      release: async () => {
        if (released) return;
        released = true;
        // Close every page even if one throws; a leaked page in a browser
        // that never restarts is permanent.
        await Promise.allSettled(pages.map((p) => p.close()));
        for (let i = 0; i < pages.length; i++) this.#releasePageSlot();
      },
    };
  }

  /** Closes Chromium and rejects anyone still queued for a page slot. */
  async close(): Promise<void> {
    this.#closed = true;

    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(new Error("BrowserSession is closed"));

    this.#openPages = 0;
    await this.#chromium.close();
  }

  /** The memoized context, launched on first use. See LazyLaunch. */
  async #ensureContext(): Promise<BrowserContext> {
    return this.#chromium.get();
  }

  /**
   * `launchPersistentContext` returns a BrowserContext directly — with a
   * persistent profile there is no separate Browser object, which is why this
   * class holds a context and not a browser.
   *
   * A profile lock naming another machine is the one launch failure that
   * persists forever after an ungraceful stop. Diagnose it by default; only
   * remove it when an operator has explicitly declared this deployment the
   * profile's sole writer.
   */
  async #launchContext(): Promise<BrowserContext> {
    try {
      return await this.#launchOnce();
    } catch (err) {
      const staleLock = findStaleProfileLock(this.#profileDir);
      if (!staleLock || !this.#unlockStaleProfile) {
        log.error("chromium failed to launch", {
          profile: this.#profileDir,
          ...(staleLock ? { lock: staleLock.path, lockHost: staleLock.ownerHostname } : {}),
          cause: causeOf(err),
        });
        throw new BrowserUnavailableError(err, staleLock);
      }

      // This is intentionally just SingletonLock. SingletonCookie and
      // SingletonSocket are supporting state; deleting them is unnecessary
      // and broadens the opt-in destructive action beyond the actual lock.
      try {
        removeStaleProfileLock(staleLock);
      } catch (unlockError) {
        log.error("could not remove stale Chromium profile lock", {
          profile: this.#profileDir,
          lock: staleLock.path,
          lockHost: staleLock.ownerHostname,
          cause: causeOf(unlockError),
        });
        throw new BrowserUnavailableError(err, staleLock);
      }

      log.warn("removed stale Chromium profile lock; retrying launch", {
        profile: this.#profileDir,
        lock: staleLock.path,
        lockHost: staleLock.ownerHostname,
      });
      try {
        return await this.#launchOnce();
      } catch (retryError) {
        log.error("chromium failed after stale profile lock recovery", {
          profile: this.#profileDir,
          lock: staleLock.path,
          cause: causeOf(retryError),
        });
        throw new BrowserUnavailableError(retryError);
      }
    }
  }

  /** Starts Chromium once, keeping the launch/recovery policy above small. */
  async #launchOnce(): Promise<BrowserContext> {
    const launchOptions = typeof this.#launchOptions === "function" ? await this.#launchOptions() : this.#launchOptions;
    const context = await chromium.launchPersistentContext(this.#profileDir, {
      headless: true,
      ...launchOptions,
    });

    try {
      // Before any page exists, so the very first navigation is covered.
      if (this.#initScript) await context.addInitScript(this.#initScript);

      // A crashed or externally-killed browser must not be handed out again;
      // dropping the reference makes the next acquire relaunch.
      context.on("close", () => this.#chromium.forget(context));

      log.info("chromium launched", { role: "search", profile: this.#profileDir });
      return context;
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
  }

  #reservePageSlot(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    if (this.#openPages < this.#maxPages) {
      this.#openPages++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };

      const onAbort = () => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error("Aborted while waiting for a browser page slot"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #releasePageSlot(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.#openPages = Math.max(0, this.#openPages - 1);
  }
}

/** What the browser layer reads out of the configuration tree. */
export interface BrowserRuntimeConfig {
  readonly paths: PathsConfig;
  readonly archive: ArchiveConfig;
  readonly browser: {
    readonly maxPages: number;
    readonly locale: string;
    readonly timezone: string;
    readonly profileUnlock: boolean;
  };
  readonly search: {
    readonly resultsTimeoutMs: number;
    readonly sessionTimeoutMs: number;
    readonly reserveMs: number;
    readonly throttle: {
      readonly minIntervalMs: number;
      readonly jitter: number;
      readonly maxQueued: number;
    };
  };
}

/**
 * Builds the BrowserSession a front door uses by default.
 *
 * Each surface gets its own profile directory because a Chromium user-data
 * directory is single-writer: `npm run dev` starts the API and MCP server
 * together, and they would otherwise fight over one profile. The tradeoff is
 * that they don't share cookies with each other — each builds its own
 * history. `paths.dataDir` moves the whole persistent state tree;
 * `paths.profileDir` remains a profile-only override.
 *
 * The browser identity comes from stealth.ts, given the configured locale
 * and time zone: both must stay plausible for the egress IP, which is a
 * deployment fact rather than something derivable here. `launchOptions` is a
 * factory so the user agent can name the version of the binary that is
 * actually about to launch, without interrogating it until something needs
 * a browser.
 */
export function createDefaultBrowserSession(surface: string, config: BrowserRuntimeConfig): BrowserSession {
  return new BrowserSession({
    profileDir: resolveProfileDir(config.paths, surface),
    maxPages: config.browser.maxPages,
    unlockStaleProfile: config.browser.profileUnlock,
    launchOptions: async () =>
      buildStealthOptions({
        major: await resolveChromiumMajor(chromium.executablePath()),
        locale: config.browser.locale,
        timezoneId: config.browser.timezone,
      }),
    initScript: STEALTH_INIT,
  });
}

/**
 * Builds a registry backed by a real browser, for a named surface
 * ("api", "mcp", "cli"). This lives in the browser subpath rather than
 * alongside createDefaultRegistry() so that importing "@searchicus/core"
 * never pulls Playwright into the module graph — which keeps it out of the
 * UI's bundle and out of test runs that have no browser installed.
 *
 * Everything an operator can set arrives here as configuration: nothing
 * below a front door reads the environment for itself.
 */
export function createBrowserRegistry(
  surface: string,
  config: BrowserRuntimeConfig,
  options: Omit<SearchEngineRegistryOptions, "browser"> = {},
): SearchEngineRegistry {
  return createDefaultRegistry({
    resultsTimeoutMs: config.search.resultsTimeoutMs,
    sessionTimeoutMs: config.search.sessionTimeoutMs,
    searchReserveMs: config.search.reserveMs,
    throttle: { ...config.search.throttle },
    ...options,
    browser: createDefaultBrowserSession(surface, config),
    archive: options.archive === undefined ? createDefaultSearchArchive(config) : options.archive,
  });
}

import type { Page } from "playwright";

/**
 * A checked-out browser resource for one search. Engines receive this from
 * `SearchContext.acquireBrowser()` and never touch the underlying Browser or
 * BrowserContext — those are shared, long-lived, and owned by the pool-free
 * `BrowserSession` in `browser.ts`. Handing out a page instead of a browser
 * means an engine can't close a resource other searches are still using.
 *
 * Pages handed out here all live in the *same* persistent BrowserContext, so
 * they share cookies, localStorage, and cache. That sharing is deliberate:
 * it's what makes the automation look like one long-running browser with a
 * history rather than a fresh profile per query.
 *
 * Leases are released by the registry when the search session completes —
 * not when its results are ready — so an engine may keep using its page
 * after it has already returned results.
 */
export interface BrowserLease {
  /** A page opened for this search, in the shared persistent context. */
  readonly page: Page;
  /** Opens an additional page in the same context. Closed on release too. */
  newPage(): Promise<Page>;
}

/**
 * The per-search environment handed to `SearchEngine.search()`. Browser
 * access is lazy on purpose: an engine that doesn't need a browser (the mock
 * engine, say) never triggers a Chromium launch, which keeps the test suite
 * browser-free and lets the whole stack run with no Playwright system
 * dependencies installed.
 */
export interface SearchContext {
  /**
   * Leases a page from the shared browser session, launching Chromium on
   * first use. May be called more than once for additional isolated pages.
   * Rejects if the session's deadline passes while waiting for a free slot.
   */
  acquireBrowser(): Promise<BrowserLease>;
  /** Aborted when the search's deadline passes or the registry shuts down. */
  readonly signal: AbortSignal;
}

/** A lease plus its release hook. Engines get `.lease`; the registry holds `.release`. */
export interface BrowserLeaseHandle {
  readonly lease: BrowserLease;
  /** Closes every page this lease opened. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * What the registry needs from a browser. `BrowserSession` in `browser.ts`
 * is the real implementation; depending on this interface instead keeps the
 * registry free of any Playwright import and lets tests substitute a fake
 * (a class with #private fields can't be satisfied structurally).
 */
export interface BrowserProvider {
  acquire(signal?: AbortSignal): Promise<BrowserLeaseHandle>;
  close(): Promise<void>;
}

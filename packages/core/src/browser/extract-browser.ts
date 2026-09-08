import { chromium, type APIResponse, type Browser, type BrowserContext, type Page, type Route } from "playwright";

import type { ExtractionArchive } from "../archive.js";
import { assertPublicHost, parseExtractUrl } from "../extract/address.js";
import { ExtractionService } from "../extract/service.js";
import { causeOf, createLogger } from "../logger.js";
import { createDefaultSearchArchive } from "../storage.js";
import type { SearchicusConfig } from "../config.js";
import { DEFAULT_EXTRACT_CONFIG, type ExtractConfig } from "../extract/config.js";
import { ExtractFailedError } from "../extract/errors.js";
import type { PageRenderer, RenderDegradation, RenderedPage } from "../extract/types.js";
import { extractDwell } from "./dwell.js";
import { LazyLaunch } from "./lazy-launch.js";
import { buildStealthBrowserOptions, resolveChromiumMajor, STEALTH_INIT } from "./stealth.js";
import type { BrowserIdentity } from "./stealth.js";
import { BrowserUnavailableError } from "./session.js";

/**
 * Resource types a page may load. Everything absent is refused.
 *
 * Scripts and stylesheets are here because extraction renders before it
 * parses, and a modern page frequently has no content at all until its
 * JavaScript has run — that is the whole reason this is a browser and not a
 * fetch. Images, fonts, media and manifests are refused because Defuddle
 * discards them anyway, so they would be bandwidth and time spent on bytes
 * that never reach the caller.
 */
const ALLOWED_RESOURCE_TYPES = new Set(["document", "script", "stylesheet", "xhr", "fetch", "preflight", "other"]);

/**
 * Hard ceiling on requests one page may make, independent of bytes.
 *
 * The byte budget cannot see a response that arrives without a
 * Content-Length, so a page streaming thousands of chunked responses would
 * otherwise be bounded only by the clock. This is the backstop for that.
 */
export const MAX_PAGE_REQUESTS = 300;

const log = createLogger("extract");

export interface ExtractionBrowserOptions {
  config?: ExtractConfig;
  /**
   * Locale and time zone, which must be the ones search runs with.
   *
   * Defaults to the built-in identity, which is right for tests and for a
   * caller that configured nothing. A front door passes the `browser` slice:
   * an operator who moved the search browser to Europe and left this one in
   * Chicago has two browsers on one host telling different stories about the
   * machine, which is the contradiction stealth.ts exists to avoid.
   */
  identity?: BrowserIdentity;
  /**
   * The address check applied to the initial URL and every request routed
   * afterwards. Defaults to `assertPublicHost`.
   *
   * Injectable as a whole rather than as a resolver, because the default
   * deliberately never resolves a literal address — so a test serving from
   * 127.0.0.1 cannot be waved through by a fake resolver, and pretending
   * otherwise would mean testing routing through a policy that is not the
   * real one. The policy itself is covered directly in address.test.ts.
   */
  assertAddress?: (hostname: string) => Promise<void>;
}

/**
 * Renders arbitrary caller-supplied URLs, in isolation from search.
 *
 * A second browser, deliberately. `BrowserSession` uses
 * `launchPersistentContext`, whose context has no Browser behind it, so there
 * is no way to open a second, profile-free context in that process even if we
 * wanted one — and we do not: that profile carries the cookies, cache,
 * localStorage and history that make search traffic look like a person, and
 * none of it should ever be exposed to a URL a caller chose.
 *
 * So: one long-lived non-persistent browser, a fresh context per extraction,
 * closed on every outcome. Contexts are cheap; a Chromium start is not, which
 * is why the browser outlives the request and the context does not.
 *
 * The browser identity is shared with search — the same version-derived user
 * agent, locale, timezone, launch arguments and init script — because two
 * different stories from one host is itself a signal.
 */
export class ExtractionBrowser implements PageRenderer {
  readonly #config: ExtractConfig;
  readonly #identity: BrowserIdentity | undefined;
  readonly #assertAddress: (hostname: string) => Promise<void>;
  readonly #chromium: LazyLaunch<Browser>;
  #contextOptions: Awaited<ReturnType<typeof buildStealthBrowserOptions>>["context"] | undefined;
  #closed = false;

  constructor(options: ExtractionBrowserOptions = {}) {
    this.#config = options.config ?? DEFAULT_EXTRACT_CONFIG;
    this.#identity = options.identity;
    this.#assertAddress = options.assertAddress ?? ((hostname) => assertPublicHost(hostname));
    this.#chromium = new LazyLaunch(
      () => this.#launchBrowser(),
      (browser) => browser.close(),
    );
  }

  /**
   * The identity this browser will report, or undefined for the built-in one.
   *
   * Exposed because "do both browsers tell the same story" is a question
   * about this process that nothing else can answer from outside.
   */
  get identity(): BrowserIdentity | undefined {
    return this.#identity;
  }

  /** True once Chromium has actually started. Nothing starts until first use. */
  get launched(): boolean {
    return this.#chromium.launched;
  }

  async render(url: string, signal: AbortSignal): Promise<RenderedPage> {
    if (this.#closed) throw new ExtractFailedError("cancelled", "Extraction is shutting down.");
    if (signal.aborted) throw new ExtractFailedError("cancelled", "Extraction was cancelled.");

    const browser = await this.#ensureBrowser();
    const context = await browser.newContext({
      ...this.#contextOptions,
      // A service worker could serve, cache, and outlive the page's content.
      serviceWorkers: "block",
      acceptDownloads: false,
    });

    // Playwright has no AbortSignal support, so cancellation is expressed the
    // way the browser understands it: closing the context, which rejects
    // every call still in flight against it.
    const onAbort = (): void => void context.close().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await context.addInitScript(STEALTH_INIT);
      const page = await context.newPage();
      const budget = await this.#installPolicy(context, page);

      // The redirect chain is resolved and validated before the browser is
      // pointed anywhere, so the navigation below goes straight to the real
      // destination. Landing there rather than being handed its body at the
      // original address is what gives the document the right origin — and
      // therefore the right base for every relative URL in it.
      const landing = await this.#resolveChain(context, url, budget);
      budget.preloaded = landing;
      budget.finalUrl = landing.url;
      budget.status = landing.response.status();
      budget.contentType = contentTypeValue(landing.response.headers());

      await page
        .goto(landing.url, { waitUntil: "domcontentloaded", timeout: this.#config.navigationTimeoutMs })
        .catch((err: unknown) => {
          // Chromium reports all four of these as the same routed-away
          // navigation error, so the reason has to be remembered here.
          if (budget.docTooLarge) throw tooLarge(err);
          if (budget.redirectsExceeded) {
            throw new ExtractFailedError("navigation_failed", "That page redirected too many times.", err);
          }
          if (budget.blocked) throw ExtractFailedError.blockedAddress(err);
          throw new ExtractFailedError("navigation_failed", "That page could not be loaded.", err);
        });

      // The readiness policy, kept deliberately simple and predictable: reach
      // domcontentloaded, then wait a fixed period. `networkidle` is not used
      // as the decision, because polling, analytics, streams and long-lived
      // connections mean plenty of ordinary pages never reach it. Replacing
      // this with an adaptive signal — settled body text, DOM mutation
      // quiescence, relevant in-flight requests — is the intended next step,
      // and only this block has to change.
      await settleFor(this.#config.settleTimeoutMs, signal);

      // Human-shaped reading time. Its scrolling is not only realism: it is
      // what brings viewport-triggered lazy content into the DOM before the
      // capture below.
      if (this.#config.dwell) await extractDwell(page, signal);

      // Only the document cap fails a render. A page that merely spent its
      // transfer or request budget is parsed from whatever arrived: the
      // document was in hand long before the assets that overran the budget,
      // and refusing to return it would discard the answer over the cost of
      // the decoration around it. The cap that did trip is reported instead.
      //
      // Checked here as well as in the navigation handler because a page can
      // steer itself somewhere oversized after load, where there is no goto
      // left to fail.
      if (budget.docTooLarge) throw tooLarge();

      const html = await page.content();
      return {
        finalUrl: budget.finalUrl ?? page.url(),
        html,
        ...(budget.status === undefined ? {} : { status: budget.status }),
        ...(budget.contentType === undefined ? {} : { contentType: budget.contentType }),
        redirects: budget.redirects,
        ...(budget.degradedBy === undefined ? {} : { degradedBy: budget.degradedBy }),
      };
    } catch (err) {
      if (signal.aborted) throw new ExtractFailedError("timeout", "That page took too long to load.", err);
      if (err instanceof ExtractFailedError) throw err;
      throw new ExtractFailedError("unknown", "That URL could not be extracted.", err);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#chromium.close();
  }

  /**
   * Applies the request policy for one page and returns its running tallies.
   *
   * Registered before any navigation, so the very first request — the one
   * the caller chose — is judged by the same rules as everything the page
   * asks for afterwards. Note this is defense in depth: Chromium resolves and
   * connects on its own, so a name that answers publicly here and privately a
   * moment later is not caught by anything below. The operator's outbound
   * network restriction remains the load-bearing control.
   */
  async #installPolicy(context: BrowserContext, page: Page): Promise<PageBudget> {
    const budget: PageBudget = {
      bytes: 0,
      requests: 0,
      redirects: 0,
      blocked: false,
      fetchStopped: false,
      docTooLarge: false,
      redirectsExceeded: false,
    };
    // Caching within a single render also removes a window in which one
    // host's answer could change midway through a page.
    const resolved = new Map<string, Promise<void>>();

    // Awaited, not fired and forgotten. This registration is the whole
    // request policy, and letting a navigation start before it is in place
    // would leave the ordering of two protocol messages as the only thing
    // deciding whether the policy applied.
    await context.route("**/*", async (route) => {
      try {
        await this.#screen(route, page, budget, resolved);
      } catch (err) {
        budget.blocked = true;
        // Debug rather than warn: an ordinary page refers to plenty of hosts
        // this policy declines, and one line per refusal at info would drown
        // everything else.
        log.debug("request refused", { url: route.request().url(), cause: causeOf(err) });
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });

    // WebSockets are not HTTP and never reach the handler above, so a page
    // could otherwise open one to any address it liked. Nothing Defuddle
    // reads arrives over a socket, so the whole protocol is refused: the
    // handler never calls connectToServer(), and no connection is made.
    await context.routeWebSocket("**", (socket) => socket.close());

    // Popups and downloads are refused rather than merely unhandled: an
    // unclosed popup keeps the context alive, and a download is content
    // arriving by a path that bypasses every check above.
    page.on("popup", (popup) => void popup.close().catch(() => undefined));
    page.on("download", (download) => void download.cancel().catch(() => undefined));

    page.on("response", (response) => {
      // The main document is measured from its body in #resolveChain and
      // #followDocument — the one number that may decide whether a page fails
      // — so it is counted exactly once there and never again from a header
      // here. Every other response a page asks for is sub-resource traffic,
      // and those are the bytes this budget exists to bound.
      //
      // Belt and braces rather than a bug fixed: a document reaches the
      // browser through route.fulfill(), which does not propagate the
      // upstream content-length, so today this listener sees no length for it
      // and adds nothing. That is Playwright's behaviour and not a promise,
      // and the day it changes the budget would silently double-count every
      // page it measures — which no black-box test could catch, since every
      // main-frame document arrives here by that same path.
      if (response.frame() === page.mainFrame() && response.request().resourceType() === "document") return;

      const length = Number(response.headers()["content-length"]);
      // Advisory by necessity: a chunked response reports no length, which is
      // why MAX_PAGE_REQUESTS and the end-to-end deadline back this up. The
      // document itself is measured from its body instead, in #resolveChain
      // and #followDocument, so the one response whose size decides an
      // outcome never depends on a header.
      if (Number.isFinite(length)) budget.bytes += length;
      // finalUrl, not page.url(): a sub-resource that overruns the budget
      // mid-load can arrive before the page's address has committed, and the
      // operator reading this back has the destination, not about:blank, in hand.
      if (budget.bytes > this.#config.maxBytes) this.#degrade(budget, "bytes", budget.finalUrl ?? page.url());
    });

    return budget;
  }

  /**
   * Records that a bound stopped this render fetching, and logs it once.
   *
   * First cap wins. A page that overran its transfer budget and then ran out
   * of requests was stopped by the first of those; the second is a
   * consequence of the stop, not another cause of it.
   *
   * At info rather than warn: nothing failed, and an operator reading this
   * back is usually asking why one page came out thin, not being told to act.
   * Logged against the page rather than the request that crossed the line,
   * because the page is what the archive row is keyed by and so what an
   * operator has in hand when they come looking.
   */
  #degrade(budget: PageBudget, by: RenderDegradation, page: string): void {
    budget.fetchStopped = true;
    if (budget.degradedBy !== undefined) return;

    budget.degradedBy = by;
    log.info("render degraded", { url: page, by, bytes: budget.bytes, requests: budget.requests });
  }

  async #screen(route: Route, page: Page, budget: PageBudget, resolved: Map<string, Promise<void>>): Promise<void> {
    const request = route.request();

    // The document already fetched in #resolveChain is exempt from both
    // bounds. Its bytes were spent before either could trip, so refusing to
    // hand over a body sitting in memory buys nothing and costs the read: the
    // navigation fails, and a page that loaded perfectly is reported as one
    // that could not be loaded. That is reachable whenever the document alone
    // outweighs the transfer budget — which the configuration loader prevents
    // an operator from configuring, but a caller building an ExtractConfig by
    // hand still can, so the guarantee belongs here as well as there.
    //
    // Deliberately narrow. A navigation the page starts for itself fetches a
    // *new* document, which is fresh spending after the decision to stop, and
    // is still refused below.
    const alreadyFetched =
      budget.preloaded?.url === request.url() &&
      request.resourceType() === "document" &&
      request.frame() === page.mainFrame();

    if (!alreadyFetched && (budget.fetchStopped || budget.requests >= MAX_PAGE_REQUESTS)) {
      // finalUrl, not page.url(): a request that trips the budget mid-load
      // may fire before the page's address has committed, and the operator
      // reading this back has the destination, not about:blank, in hand.
      if (!budget.fetchStopped) this.#degrade(budget, "requests", budget.finalUrl ?? page.url());
      await route.abort("failed");
      return;
    }

    // Subframes are refused wholesale. An iframe is a second document with
    // its own origin and its own appetite for requests, it contributes
    // nothing Defuddle reads from the main document, and allowing it would
    // multiply this policy's surface by however many frames a page cares to
    // open.
    if (request.frame() !== page.mainFrame() || !ALLOWED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort("blockedbyclient");
      return;
    }

    await this.#screenHost(request.url(), resolved);

    // Chromium follows a redirect chain internally after `route.continue()`
    // and never re-enters this handler — verified, not assumed. Continuing a
    // navigation would therefore leave every hop after the first unchecked,
    // and an open redirect on an ordinary site would be enough to reach a
    // private address. The main document is never continued, then: it is
    // either the response already resolved for this render, or a later
    // navigation followed one screened hop at a time.
    if (request.resourceType() === "document" && request.frame() === page.mainFrame()) {
      const preloaded = budget.preloaded;
      if (preloaded && preloaded.url === request.url()) {
        // Fulfilled from the body fetched while resolving the chain, so the
        // destination is read exactly once however many hops led to it.
        budget.preloaded = undefined;
        await route.fulfill({ response: preloaded.response });
        return;
      }

      // A navigation the page started itself, which no earlier resolution
      // covers. Followed hop by hop, with each destination screened.
      await this.#followDocument(route, budget, resolved);
      return;
    }

    budget.requests++;
    await route.continue();
  }

  /**
   * Fetches the main document, validating every redirect destination.
   *
   * The browser is handed the final answer through `fulfill`, so it never
   * learns it was redirected — which is why the true destination is tracked
   * here and reported as `finalUrl` rather than read back from `page.url()`.
   */
  async #followDocument(route: Route, budget: PageBudget, resolved: Map<string, Promise<void>>): Promise<void> {
    let target = route.request().url();
    let response = await route.fetch({ maxRedirects: 0 });
    budget.requests++;

    while (response.status() >= 300 && response.status() < 400) {
      const location = response.headers()["location"];
      if (!location) break;

      if (budget.redirects >= this.#config.maxRedirects) {
        budget.redirectsExceeded = true;
        await route.abort("failed");
        return;
      }

      target = new URL(location, target).toString();
      await this.#screenHost(target, resolved);
      budget.redirects++;
      budget.requests++;
      response = await route.fetch({ url: target, maxRedirects: 0 });
    }

    // The same cap as #resolveChain, applied to the navigations a page starts
    // for itself. Without it the document bound would hold only for the URL
    // the caller named, and one meta-refresh would be enough to walk around
    // it. A body that cannot be read is left unmeasured rather than treated
    // as a failure: fulfill is about to fail on it anyway, and reporting a
    // size for something never received would be a guess.
    const body = await response.body().catch(() => undefined);
    if (body) {
      budget.bytes += body.byteLength;
      if (body.byteLength > this.#config.maxDocumentBytes) {
        budget.docTooLarge = true;
        await route.abort("failed");
        return;
      }
    }

    budget.finalUrl = target;
    budget.status = response.status();
    budget.contentType = contentTypeValue(response.headers());
    await route.fulfill({ response });
  }

  /**
   * Follows the redirect chain for the initial URL, screening every hop, and
   * returns the destination together with the response already read from it.
   *
   * Done before navigation rather than during it because of what a redirect
   * means to the browser. Fulfilling the destination's body against the
   * original request leaves the document's URL — and so its origin, and so
   * the base for every relative link, script and stylesheet in it — set to
   * the address that only redirected. A page reached through a shortener
   * then asks the shortener for its assets, gets 404s, and renders as an
   * empty shell: the exact failure a browser was chosen to avoid.
   *
   * Uses the context's own request API, so the cookies, headers and identity
   * are the ones the page itself would have sent.
   */
  async #resolveChain(context: BrowserContext, url: string, budget: PageBudget): Promise<PreloadedDocument> {
    const resolved = new Map<string, Promise<void>>();
    let target = url;

    for (let hop = 0; ; hop++) {
      // Screening and fetching fail for entirely different reasons, and the
      // caller is told which: a refused address must never be reported as a
      // page that would not load, or the difference between "we would not"
      // and "it did not" is lost.
      await this.#screenHost(target, resolved).catch((err: unknown) => {
        budget.blocked = true;
        throw err instanceof ExtractFailedError ? err : ExtractFailedError.blockedAddress(err);
      });
      budget.requests++;

      const response = await context.request
        .get(target, {
          maxRedirects: 0,
          timeout: this.#config.navigationTimeoutMs,
          failOnStatusCode: false,
        })
        .catch((err: unknown) => {
          throw new ExtractFailedError("navigation_failed", "That page could not be loaded.", err);
        });

      const location = redirectTarget(response);
      if (!location) {
        // The document is measured from the body that actually arrived, not
        // from its Content-Length. A size that decides an outcome must not be
        // one a server can misdeclare or — as a chunked response does —
        // decline to state at all, which is how a 6.9 MB JSON dump used to
        // pass for a page. Reading it here costs nothing extra: this body is
        // the one handed to the navigation below, fetched exactly once.
        const body = await response.body().catch((err: unknown) => {
          throw new ExtractFailedError("navigation_failed", "That page could not be read.", err);
        });
        if (body.byteLength > this.#config.maxDocumentBytes) throw tooLarge();

        budget.bytes += body.byteLength;
        if (budget.bytes > this.#config.maxBytes) this.#degrade(budget, "bytes", target);
        return { url: target, response };
      }

      if (hop >= this.#config.maxRedirects) {
        budget.redirectsExceeded = true;
        throw new ExtractFailedError("navigation_failed", "That page redirected too many times.");
      }

      target = new URL(location, target).toString();
      budget.redirects++;
    }
  }

  /** Validates one URL's scheme, port, and destination address. */
  async #screenHost(url: string, resolved: Map<string, Promise<void>>): Promise<void> {
    const target = parseExtractUrl(url, this.#config);
    // One resolution per host per page: fifty scripts on one CDN should not
    // mean fifty lookups.
    let check = resolved.get(target.hostname);
    if (!check) {
      check = this.#assertAddress(target.hostname);
      resolved.set(target.hostname, check);
    }
    await check;
  }

  /** The memoized browser, launched on first use. See LazyLaunch. */
  async #ensureBrowser(): Promise<Browser> {
    const browser = this.#chromium.current;
    // A browser that has lost its connection is dropped so the next render
    // relaunches, exactly as BrowserSession does for search.
    if (browser && !browser.isConnected()) this.#chromium.forget(browser);
    return this.#chromium.get();
  }

  async #launchBrowser(): Promise<Browser> {
    try {
      const options = buildStealthBrowserOptions({
        major: await resolveChromiumMajor(chromium.executablePath()),
        locale: this.#identity?.locale,
        timezoneId: this.#identity?.timezone,
      });
      const browser = await chromium.launch(options.launch);

      browser.on("disconnected", () => this.#chromium.forget(browser));
      log.info("chromium launched", { role: "extraction" });

      this.#contextOptions = options.context;
      return browser;
    } catch (err) {
      throw err instanceof BrowserUnavailableError ? err : new BrowserUnavailableError(err);
    }
  }
}

/**
 * Waits out the settle period, and stops the moment the extraction is
 * cancelled.
 *
 * `page.waitForTimeout` would be the obvious call and is the wrong one: it
 * runs the timer out even after the context closes underneath it, so a
 * cancelled extraction sat here for the full period before noticing.
 */
function settleFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ExtractFailedError("cancelled", "Extraction was cancelled."));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ExtractFailedError("cancelled", "Extraction was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface PageBudget {
  bytes: number;
  requests: number;
  redirects: number;
  /** Set when the policy refused a request, so a navigation failure can say why. */
  blocked: boolean;
  /**
   * Set once the render has spent enough: further requests are refused, but
   * what has already arrived is kept and parsed.
   */
  fetchStopped: boolean;
  /** Which bound stopped it, remembered for the log and the archive. */
  degradedBy?: RenderDegradation;
  /**
   * Set when a main document arrived over the document cap.
   *
   * Remembered rather than thrown for the same reason as `redirectsExceeded`:
   * inside a route handler a throw becomes a refused request, and the caller
   * would be told an address was blocked when in truth a page was too big.
   */
  docTooLarge: boolean;
  redirectsExceeded: boolean;
  /** The final main-document tuple, updated together on page-initiated navigation. */
  finalUrl?: string;
  status?: number;
  contentType?: string;
  /** The destination's response, held until the navigation asks for it. */
  preloaded?: PreloadedDocument;
}

/** A document already fetched, waiting to be handed to the navigation for it. */
interface PreloadedDocument {
  url: string;
  response: APIResponse;
}

/**
 * The document cap's failure, worded identically wherever it is raised.
 *
 * Raised from three places — the pre-navigation chain, a page-initiated
 * navigation, and the capture — and a caller comparing two of them should
 * never be able to tell which one answered.
 */
function tooLarge(cause?: unknown): ExtractFailedError {
  return new ExtractFailedError("too_large", "That page was too large to extract.", cause);
}

/** The Location of a redirect response, or undefined when it is not one. */
function redirectTarget(response: APIResponse): string | undefined {
  if (response.status() < 300 || response.status() >= 400) return undefined;
  return response.headers()["location"];
}

function contentTypeValue(headers: Record<string, string> | undefined): string | undefined {
  const value = headers?.["content-type"];
  return value ? (value.split(";")[0]?.trim() ?? value) : undefined;
}

/**
 * Builds the extraction renderer a front door uses, from its configuration.
 *
 * The identity is required rather than defaulted: a front door that has a
 * configured one and does not pass it is the failure this argument exists to
 * prevent, and a silent fallback is how it went unnoticed the first time.
 */
export function createDefaultExtractionBrowser(config: ExtractConfig, identity: BrowserIdentity): ExtractionBrowser {
  return new ExtractionBrowser({ config, identity });
}

/**
 * What the extraction stack reads out of the configuration tree.
 *
 * `browser` is in here for its identity alone: extraction has its own browser
 * and none of the rest applies to it, but the locale and time zone it reports
 * have to be the ones search reports.
 */
export type ExtractionRuntimeConfig = Pick<SearchicusConfig, "paths" | "archive" | "dashboard" | "browser" | "extract">;

/**
 * Builds the browser-backed ExtractionService a front door uses.
 *
 * The sibling of `createBrowserRegistry()`, and separate from it on purpose:
 * search and extraction share an archive file but must never share a browser.
 * Pass the registry's archive to have both use one connection; omit it and
 * this opens its own, which is safe (WAL, and the API and CLI already share
 * the file across processes) but redundant inside a single process.
 *
 * Nothing launches here. Chromium starts on the first extraction that gets
 * past validation, so a deployment with extraction disabled never pays for a
 * browser it will not use.
 */
export function createBrowserExtraction(
  config: ExtractionRuntimeConfig,
  options: { archive?: ExtractionArchive | null } = {},
): ExtractionService {
  return new ExtractionService({
    config: config.extract,
    renderer: createDefaultExtractionBrowser(config.extract, config.browser),
    archive: options.archive === undefined ? createDefaultSearchArchive(config) : options.archive,
  });
}

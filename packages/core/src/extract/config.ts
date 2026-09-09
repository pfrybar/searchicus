/** Markdown returned when a caller does not ask for a specific budget. */
export const DEFAULT_EXTRACT_MAX_CHARS = 20_000;
/** Ceiling on the caller-controlled Markdown budget. */
export const MAX_EXTRACT_MAX_CHARS = 100_000;
/**
 * Default budget for `find`, which is smaller on purpose.
 *
 * Matching extract's 20,000 would return most of an average page and make
 * the operation pointless. Measured against real reference pages, the median
 * section runs 437-1,525 characters, so this holds four to eight whole ones.
 */
export const DEFAULT_FIND_MAX_CHARS = 6_000;

/**
 * Operator configuration for rendered extraction.
 *
 * Every field here is deliberately absent from ExtractRequest. These are the
 * limits that protect the host, and a caller able to raise its own timeout,
 * byte budget, or concurrency share could exhaust the process by asking
 * politely.
 */
export interface ExtractConfig {
  /** Off unless explicitly enabled. See ExtractionDisabledError. */
  readonly enabled: boolean;
  /** Maximum extraction contexts open at once, across the whole process. */
  readonly maxConcurrent: number;
  /**
   * Callers that may wait for one of those, before further ones are refused.
   *
   * A render is seconds of browser work, so at the default of two at a time
   * most of a long queue would reach the front only after its own deadline
   * had passed — a place in it is a promise that cannot be kept. The cap is
   * mostly about state rather than latency: without it a burst holds one
   * timer, one abort listener and one pending request per caller, for as many
   * callers as arrive.
   */
  readonly maxQueued: number;
  /** Deadline for reaching `domcontentloaded`. */
  readonly navigationTimeoutMs: number;
  /** Fixed pause after `domcontentloaded`, before the DOM is captured. */
  readonly settleTimeoutMs: number;
  /** End-to-end budget: render, dwell, parse, and respond. */
  readonly timeoutMs: number;
  /**
   * Whether to spend a short human-shaped dwell on the page after it settles.
   * Its scrolling also brings lazy-loaded content into the DOM, so this is
   * not purely cosmetic — but an operator extracting from their own sites can
   * turn it off and get the seconds back.
   */
  readonly dwell: boolean;
  /**
   * Fetch tripwire across the whole render: main document plus every
   * subresource.
   *
   * Crossing it stops the render fetching anything further, but does not fail
   * the extraction. The two are separate because the sizes are: a page is
   * mostly images, fonts and script, none of which Defuddle reads, so asset
   * weight is a reason to stop spending and never a reason to lose a document
   * already in hand. What the caller loses when this trips is styling and
   * late-loading script, which degrades rendering rather than content — and
   * the render is recorded as degraded, so an empty result has an explanation
   * waiting in the archive.
   *
   * Header-based, and therefore advisory: a chunked response reports no
   * length and goes uncounted here. MAX_PAGE_REQUESTS and the end-to-end
   * deadline are the bounds that do not depend on a server being honest.
   */
  readonly maxBytes: number;
  /**
   * Parse bound on the main document alone. Crossing it fails the extraction
   * with `too_large`.
   *
   * Measured from the body actually received rather than its `content-length`
   * header, so a chunked megabyte counts exactly like a declared one. This is
   * the limit that means what `too_large` says: the *document* was too big to
   * read, which is a real answer about the page, unlike the weight of its
   * images.
   *
   * Lower than `maxBytes` on purpose and enforced to stay so: a document
   * cap above the transfer budget would be unreachable by construction, and
   * the failure it exists to produce could never happen. Two megabytes of
   * HTML is already far past any page written to be read — the heaviest
   * documents measured run about 1.2 MB — so what lands above it is data
   * rather than prose.
   */
  readonly maxDocumentBytes: number;
  /** Cap on the redirect chain. */
  readonly maxRedirects: number;
  /** Destination ports the renderer may open. */
  readonly allowedPorts: ReadonlySet<number>;
  /**
   * Briefly holding parsed pages so paging does not re-render.
   *
   * On by default, because without it reading a 35,000-character document in
   * six-thousand-character windows renders it seven times — seven browser
   * launches and seven requests to someone else's server to read one page
   * once. Off is a supported configuration and costs only time.
   */
  readonly cache: {
    readonly enabled: boolean;
    readonly ttlMs: number;
    readonly maxEntries: number;
    readonly maxChars: number;
  };
}

export const DEFAULT_EXTRACT_CONFIG: ExtractConfig = {
  enabled: false,
  maxConcurrent: 2,
  maxQueued: 32,
  navigationTimeoutMs: 10_000,
  settleTimeoutMs: 2_000,
  // The stages have to fit inside this: navigation (10s) plus the settle (2s)
  // plus a dwell (up to ~5.3s) plus capture and parse already reaches ~18s in
  // the worst case, so a 15s budget would fail slow pages by construction.
  // Typical pages finish in well under ten.
  timeoutMs: 30_000,
  dwell: true,
  maxBytes: 5_242_880,
  maxDocumentBytes: 2_097_152,
  maxRedirects: 5,
  allowedPorts: new Set([80, 443]),
  cache: {
    enabled: true,
    // Long enough to read a document through, short enough that a page which
    // has since changed is not served from it. Paging happens in seconds.
    ttlMs: 300_000,
    maxEntries: 32,
    // About 8MB of Markdown at worst, which is a bound worth stating: a page
    // cache without one is a memory leak with good intentions.
    maxChars: 8_000_000,
  },
};

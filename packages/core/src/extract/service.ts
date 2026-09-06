import { createHash } from "node:crypto";
import type { ArchivedResult, ExtractionArchive, ExtractionArchiveRecord } from "../archive.js";
import { causeOf, createLogger } from "../logger.js";
import { canonicalizeUrl } from "../ranking.js";
import { assertPublicHost, parseExtractUrl, type AddressLookup } from "./address.js";
import {
  DEFAULT_EXTRACT_CONFIG,
  DEFAULT_EXTRACT_MAX_CHARS,
  MAX_EXTRACT_MAX_CHARS,
  type ExtractConfig,
} from "./config.js";
import { ExtractFailedError, ExtractionBusyError, ExtractionDisabledError, ExtractRequestError } from "./errors.js";
import { PageCache, type CachedPage } from "./page-cache.js";
import { buildOutline, sliceWindow } from "./sections.js";
import type {
  DocumentParser,
  ExtractRequest,
  ExtractResponse,
  OutlineRequest,
  OutlineResponse,
  PageRenderer,
  ParsedDocument,
  RenderedPage,
} from "./types.js";

const log = createLogger("extract");

export interface ExtractionServiceOptions {
  /** Renders pages. Required before any extraction can actually run. */
  renderer?: PageRenderer;
  /** Resolves refs and records attempts. Omit to run without persistence. */
  archive?: ExtractionArchive | null;
  config?: ExtractConfig;
  /** Converts captured DOM to Markdown. Defaults to the Defuddle worker. */
  parse?: DocumentParser;
  /** Injected for tests; production resolves through the system resolver. */
  lookup?: AddressLookup;
}

/**
 * Renders one caller-supplied URL and returns its readable content.
 *
 * Deliberately not part of SearchEngineRegistry. The registry's job is to
 * drive search engines through one shared, long-lived, cookie-carrying
 * profile — the exact opposite of what arbitrary user-supplied URLs should
 * touch. Keeping them apart is what makes "extraction never sees the search
 * profile" a structural property rather than a rule someone must remember.
 *
 * The extraction attempt is itself the relevance signal: an agent choosing to
 * read result 7 is evidence about results 1 through 6. There is no separate
 * feedback call to make, and nothing for a caller to opt into.
 */
export class ExtractionService {
  readonly #renderer: PageRenderer | undefined;
  readonly #archive: ExtractionArchive | undefined;
  readonly #config: ExtractConfig;
  readonly #parse: DocumentParser | undefined;
  readonly #lookup: AddressLookup | undefined;
  readonly #slots: Semaphore;
  readonly #pendingWrites = new Set<Promise<void>>();
  readonly #overload = { refused: 0, abandoned: 0 };
  readonly #cache: PageCache | undefined;
  #closed = false;

  constructor(options: ExtractionServiceOptions = {}) {
    this.#config = options.config ?? DEFAULT_EXTRACT_CONFIG;
    this.#renderer = options.renderer;
    this.#archive = options.archive ?? undefined;
    this.#parse = options.parse;
    this.#lookup = options.lookup;
    this.#slots = new Semaphore(this.#config.maxConcurrent, this.#config.maxQueued);
    this.#cache = this.#config.cache.enabled ? new PageCache(this.#config.cache) : undefined;
  }

  /** Whether this deployment will actually extract. Front doors report it. */
  get enabled(): boolean {
    return this.#config.enabled && this.#renderer !== undefined;
  }

  get config(): ExtractConfig {
    return this.#config;
  }

  /**
   * Extractions this process turned away, since it started.
   *
   * Never archived: nothing was rendered, so there is no page outcome, and
   * writing one put this server's load into a table that describes
   * documents — 22 rows once claimed example.com had timed out while 14
   * concurrent reads of it succeeded. A process gauge instead, reset on
   * restart, and anything reporting it should say so.
   */
  get overload(): Readonly<{ refused: number; abandoned: number }> {
    return { ...this.#overload };
  }

  async extract(request: ExtractRequest, options: { signal?: AbortSignal } = {}): Promise<ExtractResponse> {
    if (this.#closed) throw new ExtractFailedError("cancelled", "Extraction is shutting down.");
    const renderer = this.#renderer;
    if (!this.#config.enabled || !renderer) throw new ExtractionDisabledError();

    const startedAt = new Date().toISOString();
    const started = Date.now();

    // Caller-input failures happen before any work and are never archived:
    // they are not extraction attempts, and their messages are specific
    // precisely because they describe input the caller already holds.
    const url = parseExtractUrl(request.url, this.#config);
    const maxChars = resolveMaxChars(request.maxChars);
    const provenance = await this.#resolveRef(request.ref, url);

    const base = {
      startedAt,
      ...(provenance ? { searchId: provenance.searchId, resultRef: provenance.ref } : {}),
      requestedUrl: url.toString(),
    };

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    // A caller that has gone away should not keep a browser rendering on its
    // behalf, nor hold a place in the queue ahead of someone still waiting.
    const onCallerGone = (): void => controller.abort();
    options.signal?.addEventListener("abort", onCallerGone, { once: true });
    try {
      // Cheap rejection before a browser is involved. The renderer re-checks
      // every request it routes; this only avoids paying for a context to
      // discover that "localhost" was never going anywhere.
      await assertPublicHost(url.hostname, this.#lookup);

      const { page, cached } = await this.#loadPage(url, controller);

      const window = sliceWindow(page.markdown, {
        maxChars,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
      });
      const markdown = window.markdown;
      if (markdown.trim().length === 0) {
        throw new ExtractFailedError("no_content", "That page had no readable content to extract.");
      }

      const response: ExtractResponse = {
        url: request.url,
        finalUrl: page.finalUrl,
        ...(provenance ? { ref: provenance.ref } : {}),
        title: page.title,
        markdown,
        truncated: window.nextOffset !== undefined,
        chars: markdown.length,
        totalChars: window.totalChars,
        offset: window.offset,
        ...(window.nextOffset === undefined ? {} : { nextOffset: window.nextOffset }),
        tookMs: Date.now() - started,
        untrusted: true,
      };

      this.#record({
        ...base,
        finalUrl: page.finalUrl,
        status: "completed",
        ...(page.status === undefined ? {} : { httpStatus: page.status }),
        ...(page.contentType === undefined ? {} : { contentType: page.contentType }),
        redirects: page.redirects,
        tookMs: response.tookMs,
        title: page.title,
        domain: domainOf(page.finalUrl),
        ...(page.language === undefined ? {} : { language: page.language }),
        ...(page.author === undefined ? {} : { author: page.author }),
        ...(page.published === undefined ? {} : { published: page.published }),
        chars: markdown.length,
        wordCount: page.wordCount,
        truncated: window.nextOffset !== undefined,
        cached,
        markdownSha256: createHash("sha256").update(markdown).digest("hex"),
      });

      return response;
    } catch (err) {
      // A request error is not an extraction attempt, so it is not archived
      // and keeps its 400 rather than being flattened into a 502. Nothing
      // inside the try raises one today; an injected renderer or parser is
      // the only way it happens, and that is worth surviving.
      if (err instanceof ExtractRequestError) throw err;

      // Nor is a refusal at the door, or a caller that never reached it:
      // nothing was rendered, so there is no page outcome, and recording one
      // put this server's own load into a table that describes documents.
      if (err instanceof ExtractionBusyError) throw err;

      const failure = asExtractFailure(err, controller.signal);
      // The response is deliberately vague — a specific one would let a
      // caller map internal network space by probing. The operator gets the
      // real reason, which is the whole point of carrying a cause.
      log.warn("extraction failed", {
        url: url.toString(),
        kind: failure.kind,
        tookMs: Date.now() - started,
        cause: causeOf(failure.cause ?? err),
      });
      this.#record({
        ...base,
        status: "failed",
        errorKind: failure.kind,
        tookMs: Date.now() - started,
        domain: domainOf(url.toString()),
      });
      throw failure;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onCallerGone);
    }
  }

  /**
   * Describes a page's structure without returning its content.
   *
   * A separate operation rather than a flag on extract(): the response shape
   * is different, and a boolean that changes what comes back is a mode in
   * disguise. It also takes no budget and no offset, which is most of the
   * argument for splitting it out.
   *
   * Not archived. Nothing was read, so recording it would count structure
   * probes among the reads the extraction metrics exist to describe.
   */
  async outline(request: OutlineRequest, options: { signal?: AbortSignal } = {}): Promise<OutlineResponse> {
    if (this.#closed) throw new ExtractFailedError("cancelled", "Extraction is shutting down.");
    if (!this.#config.enabled || !this.#renderer) throw new ExtractionDisabledError();

    const started = Date.now();
    const url = parseExtractUrl(request.url, this.#config);
    const provenance = await this.#resolveRef(request.ref, url);

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    const onCallerGone = (): void => controller.abort();
    options.signal?.addEventListener("abort", onCallerGone, { once: true });

    try {
      await assertPublicHost(url.hostname, this.#lookup);
      const { page } = await this.#loadPage(url, controller);
      // From the whole document, never from a window: an outline of the part
      // that happened to fit would describe a fifth of a book as the book.
      const { sections, navigable } = buildOutline(page.markdown);

      return {
        url: request.url,
        finalUrl: page.finalUrl,
        ...(provenance ? { ref: provenance.ref } : {}),
        title: page.title,
        totalChars: page.markdown.length,
        navigable,
        sections,
        tookMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof ExtractRequestError || err instanceof ExtractionBusyError) throw err;
      const failure = asExtractFailure(err, controller.signal);
      log.warn("outline failed", { url: url.toString(), kind: failure.kind, cause: causeOf(failure.cause ?? err) });
      throw failure;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onCallerGone);
    }
  }

  /** Waits for archive writes this service has already started. */
  async drain(): Promise<void> {
    while (this.#pendingWrites.size > 0) await Promise.allSettled([...this.#pendingWrites]);
  }

  /**
   * Stops admitting work, waits for what it already owes the archive, then
   * tears the browser down.
   *
   * The order is the point. Whoever owns the shared archive closes it after
   * this resolves, so a write still in flight here would meet a closed
   * database — and be swallowed.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#cache?.clear();
    await this.drain();
    await this.#renderer?.close();
  }

  /**
   * Gets a page's parsed content, from memory when it has been read already.
   *
   * Shared by every read operation, so that a cache hit, the concurrency
   * limit, the queue's two refusal modes and the "don't keep the HTML" rule
   * are decided in one place rather than once per method.
   */
  async #loadPage(url: URL, controller: AbortController): Promise<{ page: CachedPage; cached: boolean }> {
    const renderer = this.#renderer;
    if (!renderer) throw new ExtractionDisabledError();

    // A page already read is served from memory: no slot, no browser, no
    // second request to somebody else's server. Everything above still
    // runs — the ref must still check out, and the address is still
    // screened — because a cache is an optimisation and not a bypass.
    const cacheKey = url.toString();
    let page = this.#cache?.get(cacheKey);
    const cached = page !== undefined;

    if (!page) {
      // Queue time counts against the deadline, so giving up here is giving
      // up waiting for this server rather than waiting for the page. Told
      // apart because the difference decides whether the caller retries and
      // whether the archive believes the page was slow.
      const admitted = Date.now();
      await this.#slots.acquire(controller.signal).catch((err: unknown) => {
        if (err instanceof ExtractionBusyError) {
          this.#overload.refused++;
          log.warn("extraction refused, queue full", { queued: err.queued });
          throw err;
        }
        this.#overload.abandoned++;
        log.warn("extraction gave up waiting for a slot", { waitedMs: Date.now() - admitted });
        throw new ExtractionBusyError(0, "queue_timeout");
      });

      let rendered: RenderedPage;
      let parsed: ParsedDocument;
      try {
        rendered = await renderer.render(cacheKey, controller.signal);
        // The slot is held across the parse too. Parsing spawns a
        // memory-capped worker per document, and releasing before it meant
        // the limit bounded renders while workers piled up behind them —
        // capping the cheap half of the work and not the expensive one.
        const parse = this.#parse ?? (await this.#defaultParser());
        parsed = await parse(rendered.html, rendered.finalUrl, controller.signal);
      } finally {
        this.#slots.release();
      }

      // The captured HTML is deliberately not kept: it is the largest thing
      // here and nothing downstream reads it once the Markdown exists.
      page = {
        finalUrl: rendered.finalUrl,
        ...(rendered.status === undefined ? {} : { status: rendered.status }),
        ...(rendered.contentType === undefined ? {} : { contentType: rendered.contentType }),
        redirects: rendered.redirects,
        title: parsed.title,
        markdown: parsed.markdown,
        wordCount: parsed.wordCount,
        ...(parsed.language === undefined ? {} : { language: parsed.language }),
        ...(parsed.author === undefined ? {} : { author: parsed.author }),
        ...(parsed.published === undefined ? {} : { published: parsed.published }),
      };
      this.#cache?.set(cacheKey, page);
    }
    return { page, cached };
  }

  /**
   * Turns a ref into verified provenance, or rejects.
   *
   * A ref must name an archived result whose URL is the one being extracted.
   * Accepting an unverifiable ref would let a caller attach a search's
   * provenance to an unrelated URL, which would quietly poison the ranking
   * data this whole phase exists to collect — the one failure mode that
   * cannot be detected after the fact.
   */
  async #resolveRef(ref: string | undefined, url: URL): Promise<ArchivedResult | undefined> {
    if (ref === undefined) return undefined;

    if (!this.#archive) {
      throw new ExtractRequestError(
        "This server has no search archive, so a ref cannot be verified. Extract the URL without one.",
      );
    }

    let found: ArchivedResult | undefined;
    try {
      found = await this.#archive.findResult(ref);
    } catch (err) {
      throw new ExtractFailedError("unknown", "Extraction is temporarily unavailable.", err);
    }

    if (!found) {
      throw new ExtractRequestError(`ref "${ref}" does not name a result from an archived search.`);
    }
    if (canonicalizeUrl(found.url) !== canonicalizeUrl(url.toString())) {
      throw new ExtractRequestError(`ref "${ref}" names a different URL than the one requested.`);
    }

    return found;
  }

  /** Loaded on first use so importing core never spawns worker machinery. */
  async #defaultParser(): Promise<DocumentParser> {
    const { createWorkerParser } = await import("./markdown.js");
    return createWorkerParser();
  }

  /**
   * Archive writes never change an extraction's success or its failure — but
   * they are still work this service owns.
   *
   * Untracked, a write started as the response went out could still be in
   * flight when shutdown closed the shared archive underneath it, and the
   * failure is swallowed here, so the record vanished with nothing said. The
   * search registry already tracked its own writes; this is the same promise
   * kept for extraction.
   */
  #record(record: ExtractionArchiveRecord): void {
    const archive = this.#archive;
    if (!archive) return;

    const write: Promise<void> = archive
      .recordExtraction(record)
      .catch((err: unknown) => {
        log.warn("extraction archive write failed", { url: record.requestedUrl, cause: causeOf(err) });
      })
      .finally(() => this.#pendingWrites.delete(write));
    this.#pendingWrites.add(write);
  }
}

/** Normalizes anything thrown mid-extraction into a safe public failure. */
function asExtractFailure(err: unknown, signal: AbortSignal): ExtractFailedError {
  if (err instanceof ExtractFailedError) return err;

  // An abort mid-flight is the deadline in almost every case; distinguishing
  // it from an explicit cancel matters for the archive's failure counts.
  if (signal.aborted) return new ExtractFailedError("timeout", "That page took too long to load.", err);

  return new ExtractFailedError("unknown", "That URL could not be extracted.", err);
}

function resolveMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EXTRACT_MAX_CHARS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExtractRequestError("maxChars must be a positive integer.");
  }
  return Math.min(value, MAX_EXTRACT_MAX_CHARS);
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Counting semaphore with a bounded FIFO queue, cancellable while waiting. */
class Semaphore {
  #available: number;
  readonly #maxQueued: number;
  #waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  constructor(limit: number, maxQueued: number) {
    this.#available = Math.max(1, limit);
    this.#maxQueued = Math.max(1, maxQueued);
  }

  get queued(): number {
    return this.#waiters.length;
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new ExtractFailedError("timeout", "That page took too long to load."));
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }
    // Bounded so a burst cannot hold one timer, one abort listener and one
    // pending request per caller, for as many callers as care to arrive.
    if (this.#waiters.length >= this.#maxQueued) return Promise.reject(new ExtractionBusyError(this.#waiters.length));

    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };

      const onAbort = (): void => {
        this.#waiters = this.#waiters.filter((queued) => queued !== waiter);
        reject(new ExtractFailedError("timeout", "That page took too long to load."));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  release(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.#available++;
  }
}

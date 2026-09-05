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
import { sliceWindow } from "./sections.js";
import type {
  DocumentParser,
  ExtractRequest,
  ExtractResponse,
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
  #closed = false;

  constructor(options: ExtractionServiceOptions = {}) {
    this.#config = options.config ?? DEFAULT_EXTRACT_CONFIG;
    this.#renderer = options.renderer;
    this.#archive = options.archive ?? undefined;
    this.#parse = options.parse;
    this.#lookup = options.lookup;
    this.#slots = new Semaphore(this.#config.maxConcurrent, this.#config.maxQueued);
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

      // Queue time counts against the deadline. Without that, a burst past
      // MAX_CONCURRENT would grow an unbounded queue of callers each still
      // expecting a full timeout's worth of work once they reached the front.
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
        rendered = await renderer.render(url.toString(), controller.signal);
        // The slot is held across the parse too. Parsing spawns a
        // memory-capped worker per document, and releasing before it meant
        // the limit bounded renders while workers piled up behind them —
        // capping the cheap half of the work and not the expensive one.
        const parse = this.#parse ?? (await this.#defaultParser());
        parsed = await parse(rendered.html, rendered.finalUrl, controller.signal);
      } finally {
        this.#slots.release();
      }

      const window = sliceWindow(parsed.markdown, {
        maxChars,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
      });
      const markdown = window.markdown;
      if (markdown.trim().length === 0) {
        throw new ExtractFailedError("no_content", "That page had no readable content to extract.");
      }

      const response: ExtractResponse = {
        url: request.url,
        finalUrl: rendered.finalUrl,
        ...(provenance ? { ref: provenance.ref } : {}),
        title: parsed.title,
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
        finalUrl: rendered.finalUrl,
        status: "completed",
        ...(rendered.status === undefined ? {} : { httpStatus: rendered.status }),
        ...(rendered.contentType === undefined ? {} : { contentType: rendered.contentType }),
        redirects: rendered.redirects,
        tookMs: response.tookMs,
        title: parsed.title,
        domain: domainOf(rendered.finalUrl),
        ...(parsed.language === undefined ? {} : { language: parsed.language }),
        ...(parsed.author === undefined ? {} : { author: parsed.author }),
        ...(parsed.published === undefined ? {} : { published: parsed.published }),
        chars: markdown.length,
        wordCount: parsed.wordCount,
        truncated: window.nextOffset !== undefined,
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
    await this.drain();
    await this.#renderer?.close();
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

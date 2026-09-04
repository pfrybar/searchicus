import { createHash } from "node:crypto";
import type { ArchivedResult, ExtractionArchive, ExtractionArchiveRecord } from "../archive.js";
import { canonicalizeUrl } from "../ranking.js";
import { assertPublicHost, parseExtractUrl, type AddressLookup } from "./address.js";
import {
  DEFAULT_EXTRACT_CONFIG,
  DEFAULT_EXTRACT_MAX_CHARS,
  MAX_EXTRACT_MAX_CHARS,
  type ExtractConfig,
} from "./config.js";
import { ExtractFailedError, ExtractionDisabledError, ExtractRequestError } from "./errors.js";
import type { DocumentParser, ExtractRequest, ExtractResponse, PageRenderer } from "./types.js";

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
  #closed = false;

  constructor(options: ExtractionServiceOptions = {}) {
    this.#config = options.config ?? DEFAULT_EXTRACT_CONFIG;
    this.#renderer = options.renderer;
    this.#archive = options.archive ?? undefined;
    this.#parse = options.parse;
    this.#lookup = options.lookup;
    this.#slots = new Semaphore(this.#config.maxConcurrent);
  }

  /** Whether this deployment will actually extract. Front doors report it. */
  get enabled(): boolean {
    return this.#config.enabled && this.#renderer !== undefined;
  }

  get config(): ExtractConfig {
    return this.#config;
  }

  async extract(request: ExtractRequest): Promise<ExtractResponse> {
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
    try {
      // Cheap rejection before a browser is involved. The renderer re-checks
      // every request it routes; this only avoids paying for a context to
      // discover that "localhost" was never going anywhere.
      await assertPublicHost(url.hostname, this.#lookup);

      // Queue time counts against the deadline. Without that, a burst past
      // MAX_CONCURRENT would grow an unbounded queue of callers each still
      // expecting a full timeout's worth of work once they reached the front.
      await this.#slots.acquire(controller.signal);
      let rendered;
      try {
        rendered = await renderer.render(url.toString(), controller.signal);
      } finally {
        this.#slots.release();
      }

      const parse = this.#parse ?? (await this.#defaultParser());
      const parsed = await parse(rendered.html, rendered.finalUrl, controller.signal);
      const { markdown, truncated } = truncateMarkdown(parsed.markdown, maxChars);
      if (markdown.trim().length === 0) {
        throw new ExtractFailedError("no_content", "That page had no readable content to extract.");
      }

      const response: ExtractResponse = {
        url: request.url,
        finalUrl: rendered.finalUrl,
        ...(provenance ? { ref: provenance.ref } : {}),
        title: parsed.title,
        markdown,
        truncated,
        chars: markdown.length,
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
        truncated,
        markdownSha256: createHash("sha256").update(markdown).digest("hex"),
      });

      return response;
    } catch (err) {
      const failure = asExtractFailure(err, controller.signal);
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
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
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
        "unknown_ref",
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
      throw new ExtractRequestError("unknown_ref", `ref "${ref}" does not name a result from an archived search.`);
    }
    if (canonicalizeUrl(found.url) !== canonicalizeUrl(url.toString())) {
      throw new ExtractRequestError("ref_url_mismatch", `ref "${ref}" names a different URL than the one requested.`);
    }

    return found;
  }

  /** Loaded on first use so importing core never spawns worker machinery. */
  async #defaultParser(): Promise<DocumentParser> {
    const { createWorkerParser } = await import("./markdown.js");
    return createWorkerParser();
  }

  /** Archive writes never change an extraction's success or its failure. */
  #record(record: ExtractionArchiveRecord): void {
    void this.#archive?.recordExtraction(record).catch(() => undefined);
  }
}

/** Normalizes anything thrown mid-extraction into a safe public failure. */
function asExtractFailure(err: unknown, signal: AbortSignal): ExtractFailedError {
  if (err instanceof ExtractFailedError) return err;
  if (err instanceof ExtractRequestError) throw err;

  // An abort mid-flight is the deadline in almost every case; distinguishing
  // it from an explicit cancel matters for the archive's failure counts.
  if (signal.aborted) return new ExtractFailedError("timeout", "That page took too long to load.", err);

  return new ExtractFailedError("unknown", "That URL could not be extracted.", err);
}

function resolveMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EXTRACT_MAX_CHARS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExtractRequestError("invalid_url", "maxChars must be a positive integer.");
  }
  return Math.min(value, MAX_EXTRACT_MAX_CHARS);
}

/**
 * Cuts Markdown to a caller's budget at the nearest structural boundary.
 *
 * Nothing is appended. An ellipsis or a "[truncated]" marker would be text
 * this system invented sitting inside content the response labels untrusted,
 * and `truncated` already carries that fact in a field a caller can trust.
 */
export function truncateMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };

  const cut = markdown.slice(0, maxChars);
  const half = maxChars / 2;
  const newline = cut.lastIndexOf("\n");
  const space = cut.lastIndexOf(" ");
  const end = newline > half ? newline : space > half ? space : maxChars;

  return { markdown: cut.slice(0, end).trimEnd(), truncated: true };
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Counting semaphore with a FIFO queue, cancellable while waiting. */
class Semaphore {
  #available: number;
  #waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  constructor(limit: number) {
    this.#available = Math.max(1, limit);
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new ExtractFailedError("timeout", "That page took too long to load."));
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }

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

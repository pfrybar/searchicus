/**
 * Briefly holds a parsed page so reading its second window does not render it
 * again.
 *
 * Paging works without this — every window can be served by re-rendering, and
 * must be, because the API and CLI are separate processes and a CLI paged read
 * never sees the API's memory. That is what makes this an optimisation rather
 * than a mechanism: it can be switched off, and nothing but the clock changes.
 *
 * It does change one stated property. The archive deliberately has nowhere to
 * put page text, and this holds page text — in memory, for minutes, never on
 * disk. That is a smaller claim than persistence but it is a different one,
 * and it is stated in the README rather than left as an implementation detail.
 *
 * Entries are keyed by the URL the caller asked for, so it is shared between
 * callers. On one machine that is nothing. On a shared host a hit is visible
 * in the response time, which reveals that *somebody* read that URL — the
 * content is public and anyone could fetch it themselves, so what leaks is the
 * access pattern, not the data.
 */

import type { RenderDegradation } from "./types.js";

export interface CachedPage {
  readonly finalUrl: string;
  /**
   * Carried so a cached read is archived like the render that produced it.
   * Dropping it would make the same page look degraded once and clean for the
   * five minutes of paging that follow.
   */
  readonly degradedBy?: RenderDegradation;
  readonly status?: number;
  readonly contentType?: string;
  readonly redirects: number;
  readonly title: string;
  readonly markdown: string;
  readonly wordCount: number;
  readonly language?: string;
  readonly author?: string;
  readonly published?: string;
}

export interface PageCacheOptions {
  /** How long an entry may be served for. */
  ttlMs: number;
  /** How many pages to hold, whatever their size. */
  maxEntries: number;
  /** Total characters of Markdown held, across every entry. */
  maxChars: number;
  /** Injectable clock, so tests do not wait out a TTL. */
  now?: () => number;
}

interface Entry {
  page: CachedPage;
  storedAt: number;
}

/**
 * A small LRU with a TTL and a total-size bound.
 *
 * Three bounds rather than one because each fails differently: a TTL alone
 * lets a burst of large pages sit in memory until it expires, an entry count
 * alone treats an 80,000-character page as it treats a 150-character one, and
 * a size bound alone would serve a page long after it was worth trusting.
 */
export class PageCache {
  readonly #entries = new Map<string, Entry>();
  readonly #options: PageCacheOptions;
  readonly #now: () => number;
  #chars = 0;

  constructor(options: PageCacheOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Characters of Markdown currently held. */
  get chars(): number {
    return this.#chars;
  }

  get(key: string): CachedPage | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;

    if (this.#now() - entry.storedAt > this.#options.ttlMs) {
      this.#drop(key);
      return undefined;
    }

    // Re-insert so Map iteration order is least-recently-used first.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.page;
  }

  set(key: string, page: CachedPage): void {
    this.#drop(key);

    // A page too large to hold within the total bound is not worth evicting
    // everything else for.
    if (page.markdown.length > this.#options.maxChars) return;

    this.#entries.set(key, { page, storedAt: this.#now() });
    this.#chars += page.markdown.length;

    while (this.#entries.size > this.#options.maxEntries || this.#chars > this.#options.maxChars) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#drop(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#chars = 0;
  }

  #drop(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#chars -= entry.page.markdown.length;
    this.#entries.delete(key);
  }
}

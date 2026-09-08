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
 * Entries are keyed by the final URL; a requested redirect URL is retained as
 * an alias. A direct read of a destination that was just reached through a
 * redirect therefore reuses its render. An unknown redirect alias still needs
 * one render to discover its destination. On a shared host a hit is visible in
 * the response time, which reveals that *somebody* read that public page.
 */

import type { RenderDegradation } from "./types.js";
import type { PageAssessment } from "./usability.js";

export interface CachedPage {
  readonly finalUrl: string;
  /** One query-independent decision shared by extract, find, and outline. */
  readonly assessment: PageAssessment;
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
  readonly wordCount?: number;
  /** Length of parsed Markdown before any caller-specific selection. */
  readonly documentChars: number;
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
  /** Requested redirect URL to final-URL entry key. */
  readonly #aliases = new Map<string, string>();
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

  /** Gets a page by its final URL or one requested redirect alias. */
  get(key: string): CachedPage | undefined {
    const entryKey = this.#aliases.get(key) ?? key;
    const entry = this.#entries.get(entryKey);
    if (!entry) {
      this.#aliases.delete(key);
      return undefined;
    }

    if (this.#now() - entry.storedAt > this.#options.ttlMs) {
      this.#drop(entryKey);
      return undefined;
    }

    // Re-insert so Map iteration order is least-recently-used first.
    this.#entries.delete(entryKey);
    this.#entries.set(entryKey, entry);
    return entry.page;
  }

  /**
   * Stores a page by its final URL and optionally maps requested URLs to it.
   *
   * Aliases are bookkeeping, not entries: one page occupies one LRU slot and
   * counts its Markdown once against the total-size bound.
   */
  set(key: string, page: CachedPage, aliases: readonly string[] = []): void {
    const priorAliases = this.#aliasesFor(key);
    this.#drop(key);

    // A page too large to hold within the total bound is not worth evicting
    // everything else for.
    if (page.markdown.length > this.#options.maxChars) return;

    // A final URL wins over any alias that previously named a different page.
    this.#aliases.delete(key);
    this.#entries.set(key, { page, storedAt: this.#now() });
    this.#chars += page.markdown.length;
    for (const alias of new Set([...priorAliases, ...aliases])) {
      if (alias !== key) this.#aliases.set(alias, key);
    }

    while (this.#entries.size > this.#options.maxEntries || this.#chars > this.#options.maxChars) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#drop(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#aliases.clear();
    this.#chars = 0;
  }

  #aliasesFor(key: string): string[] {
    return [...this.#aliases].flatMap(([alias, target]) => (target === key ? [alias] : []));
  }

  #drop(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) {
      this.#chars -= entry.page.markdown.length;
      this.#entries.delete(key);
    }
    for (const [alias, target] of this.#aliases) {
      if (target === key) this.#aliases.delete(alias);
    }
  }
}

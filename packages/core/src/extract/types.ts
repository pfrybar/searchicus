import type { OutlineSection } from "./sections.js";

/**
 * A request to render one public URL and return its readable content.
 *
 * Only these three fields are caller-controlled. Every browser, network, and
 * timing limit is operator configuration (see ExtractConfig): a caller that
 * could raise its own timeout or byte budget could turn this endpoint into a
 * resource-exhaustion tool against the host.
 */
/**
 * A request for a page's structure.
 *
 * Deliberately its own operation rather than a flag on ExtractRequest. A
 * boolean that changes the shape of the response is a mode in disguise, and
 * the parameter matrix that grows around one is worse than a second method.
 */
export interface OutlineRequest {
  /** Absolute http(s) URL to describe. */
  url: string;
}

/** A page's structure, addressed by the offsets `extract` already takes. */
export interface OutlineResponse {
  url: string;
  finalUrl: string;
  title: string;
  /** Length of the whole document, so a caller can size its reading. */
  totalChars: number;
  /**
   * Whether this structure is worth navigating by.
   *
   * False for a page with almost no headings, or one section holding most of
   * it. The sections are still returned — a single 68,000-character entry is
   * information — but a caller should read rather than navigate.
   */
  navigable: boolean;
  sections: OutlineSection[];
  tookMs: number;
}

export interface ExtractRequest {
  /** Absolute http(s) URL to render. */
  url: string;
  /** Maximum characters of Markdown to return. Defaults to 20,000. */
  maxChars?: number;
  /**
   * Where to start reading, in characters from the top of the document.
   *
   * Snapped back to the start of the section it lands in, so a window never
   * begins mid-sentence. Pass back the `nextOffset` of a previous response to
   * continue; omit it to start at the beginning.
   */
  offset?: number;
}

/** Readable page content, plus what a caller needs to interpret it. */
export interface ExtractResponse {
  /** The URL as requested. */
  url: string;
  /** Where the page actually resolved, after redirects. */
  finalUrl: string;
  title: string;
  markdown: string;
  /** True when content remains beyond this window. See `nextOffset`. */
  truncated: boolean;
  /** Length of the Markdown actually returned. */
  chars: number;
  /**
   * Where this window starts, after snapping to a section boundary.
   *
   * A caller that asked for an offset mid-section gets the start of that
   * section back, so a window never begins mid-sentence — the exception
   * being a section too long to return whole, which is served from exactly
   * where it was asked for because snapping would repeat it forever.
   */
  offset: number;
  /**
   * Where to continue reading. Absent once the end has been reached, which
   * is the same thing `truncated: false` says.
   */
  nextOffset?: number;
  /**
   * Characters the page held before truncation.
   *
   * `truncated` says something was lost; this says how much. Without it a
   * caller cannot tell a 5% trim from a 76% one, and so cannot decide whether
   * to ask again with a larger budget or accept what it has — measured, four
   * of six ordinary reference pages exceed the default.
   */
  totalChars: number;
  tookMs: number;
  /**
   * Always true, and deliberately impossible to omit.
   *
   * This is arbitrary web content: it may carry prompt injection, misleading
   * claims, or hostile links. Callers must treat `markdown` as retrieved data
   * to reason about, never as instructions to follow.
   */
  untrusted: true;
}

/** Stable categories for archived extraction failures. */
export type ExtractFailureKind =
  | "blocked_address"
  | "navigation_failed"
  | "timeout"
  | "too_large"
  | "no_content"
  | "parse_failed"
  | "browser_unavailable"
  | "cancelled"
  | "unknown";

/** What a renderer hands back for the parser to read. */
export interface RenderedPage {
  /** The URL the page settled on, after redirects. */
  readonly finalUrl: string;
  /** Serialized DOM captured after the readiness policy was satisfied. */
  readonly html: string;
  readonly status?: number;
  readonly contentType?: string;
  /** Redirects followed on the way to `finalUrl`. */
  readonly redirects: number;
}

/**
 * Renders one URL in isolation. The Playwright implementation lives in
 * `@searchicus/core/browser`; depending on this interface instead keeps the
 * extraction service — and therefore core's main entry — Playwright-free,
 * and lets tests drive the whole flow with no browser installed.
 */
export interface PageRenderer {
  render(url: string, signal: AbortSignal): Promise<RenderedPage>;
  close(): Promise<void>;
}

/** Readable content recovered from a rendered page. */
export interface ParsedDocument {
  title: string;
  markdown: string;
  wordCount: number;
  language?: string;
  author?: string;
  published?: string;
}

/** Converts captured DOM into readable Markdown. */
export type DocumentParser = (html: string, url: string, signal: AbortSignal) => Promise<ParsedDocument>;

import type { RelevanceReport } from "../relevance.js";

/**
 * Failures that are a property of driving a search engine through a browser,
 * rather than of any one engine's markup.
 *
 * Both of these describe a request that *succeeded* — HTTP 200, a page that
 * rendered, markup that parses. Neither is a transport error, which is why
 * neither can be detected anywhere but in the content. They carry the engine
 * name because the registry reports per-engine outcomes as strings, and
 * "returned no organic results" is not actionable without knowing whose.
 */

/** Raised when an engine answers, but the answer is not about the query. */
export class OffTargetResultsError extends Error {
  constructor(
    readonly engine: string,
    readonly query: string,
    readonly report: RelevanceReport,
  ) {
    super(
      `${engine} returned results that do not match "${query}" ` +
        `(coverage ${report.coverage.toFixed(2)}, missing: ${report.missing.join(", ")}). ` +
        `This is the degraded-serving failure, not a parse error: the page was valid and the ` +
        `results were real, they were simply answers to a different question.`,
    );
    this.name = "OffTargetResultsError";
  }
}

/**
 * Raised when an engine's search box could not be found.
 *
 * Separate from "no results" because it fails before a query is ever sent,
 * and because it means one specific thing: the site moved its input and this
 * engine's selector needs updating.
 */
export class SearchBoxUnavailableError extends Error {
  constructor(
    readonly engine: string,
    url: string,
    cause?: unknown,
  ) {
    super(
      `${engine} did not present a usable search box (at ${url}). The page loaded, so this is ` +
        `most likely a changed input element rather than a block — check the engine's searchBox().`,
    );
    this.name = "SearchBoxUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Raised when the results page never appeared, or held no organic results. */
export class NoResultsError extends Error {
  constructor(
    readonly engine: string,
    url: string,
    cause?: unknown,
  ) {
    super(
      `${engine} returned no organic results (at ${url}). Either the query genuinely has none, ` +
        `or the page is a consent wall or an anomaly challenge rather than a results page.`,
    );
    this.name = "NoResultsError";
    if (cause !== undefined) this.cause = cause;
  }
}

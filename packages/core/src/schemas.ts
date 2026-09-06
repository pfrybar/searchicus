import { z } from "zod";

import { MAX_EXTRACT_MAX_CHARS } from "./extract/config.js";
import type { ExtractRequest, FindRequest, OutlineRequest } from "./extract/types.js";
import type { SearchQuery, SearchRequest } from "./types.js";

/**
 * Upper bounds on the text a caller may send.
 *
 * Generous enough that no real request meets them and small enough that no
 * unreal one costs anything: a search engine will not accept a thousand-word
 * query, and a URL beyond two kilobytes is outside what browsers and servers
 * agree to handle. Unbounded strings reach a browser, a SQLite row, and a
 * rendered page, so the cap belongs at the door rather than at whichever of
 * those complains first.
 */
export const MAX_QUERY_LENGTH = 1_024;
export const MAX_URL_LENGTH = 2_048;

/**
 * Ceiling on the final merged result count.
 *
 * Measured rather than chosen: every engine returns one page, and merging
 * four of those and deduplicating by URL yields somewhere around twenty
 * unique results. Asking for more used to be accepted and then quietly
 * unmet — `limit=100` returned 23 with nothing to say whether the list had
 * been cut to the limit or the pool had simply run out. A ceiling near what
 * the pool actually holds keeps the number honest.
 */
export const MAX_SEARCH_LIMIT = 20;

/**
 * Validates untrusted input (HTTP request bodies, MCP tool arguments) into
 * a SearchQuery. Kept in sync with the SearchQuery interface by hand — if
 * you change one, change the other; the `satisfies` below at least catches
 * drift at compile time.
 */
export const SearchQuerySchema = z.object({
  query: z.string().trim().min(1, "query must not be empty").max(MAX_QUERY_LENGTH),
}) satisfies z.ZodType<SearchQuery>;

/** The complete generic request accepted by ordinary search front doors. */
export const SearchRequestSchema = SearchQuerySchema.extend({
  /** Final merged output count; never forwarded to an individual engine. */
  limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
}).strict() satisfies z.ZodType<SearchRequest>;

/**
 * The complete request accepted by every extract front door.
 *
 * Shape only, deliberately. Whether `url` is a usable http(s) target — its
 * scheme, credentials, port, and where it resolves — is decided by
 * `parseExtractUrl` and the address policy, so one set of rules applies
 * whether a URL arrived from a caller or from a redirect mid-render.
 */
/**
 * The request accepted by every outline front door.
 *
 * Just the page: structure takes no budget, no offset and no query, which is
 * most of why it is a separate operation.
 */
export const OutlineRequestSchema = z.object({
  url: z.string().trim().min(1, "url must not be empty").max(MAX_URL_LENGTH),
}) satisfies z.ZodType<OutlineRequest>;

export const ExtractRequestSchema = z.object({
  url: z.string().trim().min(1, "url must not be empty").max(MAX_URL_LENGTH),
  maxChars: z
    .number()
    .int()
    .positive()
    .max(MAX_EXTRACT_MAX_CHARS)
    .optional()
    .describe("Maximum characters of Markdown to return. Defaults to 20000."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Where to start reading, from a previous response's nextOffset. Snaps to a section boundary."),
}) satisfies z.ZodType<ExtractRequest>;

/**
 * The request accepted by every find front door.
 *
 * `query` is required and shares the search query's bounds: it is the same
 * kind of untrusted text arriving at the same kind of door, and a second set
 * of limits for it would be a second thing to keep in step.
 */
export const FindRequestSchema = z.object({
  url: z.string().trim().min(1, "url must not be empty").max(MAX_URL_LENGTH),
  query: z.string().trim().min(1, "query must not be empty").max(MAX_QUERY_LENGTH),
  maxChars: z
    .number()
    .int()
    .positive()
    .max(MAX_EXTRACT_MAX_CHARS)
    .optional()
    .describe("Total characters of Markdown across all matches. Defaults to 6000."),
}) satisfies z.ZodType<FindRequest>;

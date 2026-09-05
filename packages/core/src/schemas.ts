import { z } from "zod";

import { MAX_EXTRACT_MAX_CHARS } from "./extract/config.js";
import type { ExtractRequest } from "./extract/types.js";
import type { SearchQuery, SearchRequest } from "./types.js";

/**
 * Upper bounds on the text a caller may send.
 *
 * Generous enough that no real request meets them and small enough that no
 * unreal one costs anything: a search engine will not accept a thousand-word
 * query, a URL beyond two kilobytes is outside what browsers and servers
 * agree to handle, and a ref is a search id and a rank. Unbounded strings
 * reach a browser, a SQLite row, and a rendered page, so the cap belongs at
 * the door rather than at whichever of those complains first.
 */
export const MAX_QUERY_LENGTH = 1_024;
export const MAX_URL_LENGTH = 2_048;
export const MAX_REF_LENGTH = 128;
export const MAX_ENGINE_ID_LENGTH = 64;
export const MAX_ENGINE_SELECTION = 16;

/**
 * Validates untrusted input (HTTP request bodies, MCP tool arguments) into
 * a SearchQuery. Kept in sync with the SearchQuery interface by hand — if
 * you change one, change the other; the `satisfies` below at least catches
 * drift at compile time.
 */
export const SearchQuerySchema = z.object({
  query: z.string().trim().min(1, "query must not be empty").max(MAX_QUERY_LENGTH),
}) satisfies z.ZodType<SearchQuery>;

/**
 * The complete request accepted by front doors that let callers choose
 * engines. Keeping this here ensures the HTTP API and MCP tool apply the
 * same validation rather than inspecting untrusted input themselves.
 */
export const SearchRequestSchema = SearchQuerySchema.extend({
  /** Final merged output count; never forwarded to an individual engine. */
  limit: z.number().int().positive().max(100).optional(),
  engines: z
    .array(z.string().min(1, "engine id must not be empty").max(MAX_ENGINE_ID_LENGTH))
    .min(1, "engines must contain at least one engine id")
    .max(MAX_ENGINE_SELECTION, `engines must not name more than ${MAX_ENGINE_SELECTION} engines`)
    .refine((engineIds) => new Set(engineIds).size === engineIds.length, "engines must not contain duplicates")
    .optional()
    .describe("Specific engine ids to search; defaults to every registered engine."),
}) satisfies z.ZodType<SearchRequest>;

/**
 * The complete request accepted by every extract front door.
 *
 * Shape only, deliberately. Whether `url` is a usable http(s) target — its
 * scheme, credentials, port, and where it resolves — is decided by
 * `parseExtractUrl` and the address policy, so one set of rules applies
 * whether a URL arrived from a caller or from a redirect mid-render.
 */
export const ExtractRequestSchema = z.object({
  url: z.string().trim().min(1, "url must not be empty").max(MAX_URL_LENGTH),
  ref: z.string().trim().min(1, "ref must not be empty").max(MAX_REF_LENGTH).optional(),
  maxChars: z
    .number()
    .int()
    .positive()
    .max(MAX_EXTRACT_MAX_CHARS)
    .optional()
    .describe("Maximum characters of Markdown to return. Defaults to 20000."),
}) satisfies z.ZodType<ExtractRequest>;

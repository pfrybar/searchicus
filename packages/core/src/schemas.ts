import { z } from "zod";
import type { SearchQuery } from "./types.js";

/**
 * Validates untrusted input (HTTP request bodies, MCP tool arguments) into
 * a SearchQuery. Kept in sync with the SearchQuery interface by hand — if
 * you change one, change the other; the `satisfies` below at least catches
 * drift at compile time.
 */
export const SearchQuerySchema = z.object({
  query: z.string().min(1, "query must not be empty"),
  limit: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
  filters: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<SearchQuery>;

import type {
  EngineMetricsReport,
  ExtractRequest,
  ExtractResponse,
  FindRequest,
  FindResponse,
  OutlineRequest,
  OutlineResponse,
  PublicSearchResponse,
  SearchDetail,
  SearchRequest,
  SearchSummary,
} from "@searchicus/core";

// Defaults to the dev-server proxy (see vite.config.ts); override for a
// standalone production build by setting VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export type SearchResponseBody = PublicSearchResponse;

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (${res.status})`;
}

/**
 * Runs a search, cancellable through `signal`.
 *
 * Cancelling is not only a local tidy-up: searches are rate limited as whole
 * fan-outs, so a request the browser abandons would otherwise keep its place
 * in the server's queue — and the browser page behind it — for the full
 * deadline. Aborting the fetch closes the connection, which is what the
 * server watches for.
 */
export async function search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponseBody> {
  const res = await fetch(`${API_BASE}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<SearchResponseBody>;
}

export type ExtractResponseBody = ExtractResponse;

export async function extract(request: ExtractRequest, signal?: AbortSignal): Promise<ExtractResponseBody> {
  const res = await fetch(`${API_BASE}/extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<ExtractResponseBody>;
}

export type FindResponseBody = FindResponse;

export async function find(request: FindRequest, signal?: AbortSignal): Promise<FindResponseBody> {
  const res = await fetch(`${API_BASE}/find`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<FindResponseBody>;
}

export type OutlineResponseBody = OutlineResponse;

export async function outline(request: OutlineRequest, signal?: AbortSignal): Promise<OutlineResponseBody> {
  const res = await fetch(`${API_BASE}/outline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<OutlineResponseBody>;
}

/** What this deployment can actually do, so the UI can hide what it cannot. */
export interface Capabilities {
  extract: boolean;
  insights: boolean;
}

/**
 * Read once, by the shell, and passed down.
 *
 * Both answers come from the same endpoint, so asking per-feature meant two
 * identical requests on every load. Anything unreadable is treated as "off":
 * hiding a control that would have worked is a smaller mistake than offering
 * one that cannot.
 */
export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) return { extract: false, insights: false };

  const body = (await res.json().catch(() => null)) as Partial<Capabilities> | null;
  return { extract: body?.extract === true, insights: body?.insights === true };
}

export type EngineMetricsBody = EngineMetricsReport;
export type SearchSummaryBody = SearchSummary;
export type SearchDetailBody = SearchDetail;

export async function fetchEngineMetrics(window?: number): Promise<EngineMetricsBody> {
  const query = window === undefined ? "" : `?window=${window}`;
  const res = await fetch(`${API_BASE}/metrics/engines${query}`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<EngineMetricsBody>;
}

export async function fetchSearches(options: { limit?: number; before?: string } = {}): Promise<SearchSummaryBody[]> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.before !== undefined) params.set("before", options.before);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";

  const res = await fetch(`${API_BASE}/searches${suffix}`);
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { searches: SearchSummaryBody[] }).searches;
}

export async function fetchSearchDetail(searchId: string): Promise<SearchDetailBody> {
  const res = await fetch(`${API_BASE}/searches/${encodeURIComponent(searchId)}`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<SearchDetailBody>;
}

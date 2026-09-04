import type { MergedSearchResponse, SearchRequest } from "@searchicus/core";

// Defaults to the dev-server proxy (see vite.config.ts); override for a
// standalone production build by setting VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export interface EngineInfo {
  id: string;
  name: string;
}

export type SearchResponseBody = MergedSearchResponse;

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (${res.status})`;
}

export async function listEngines(): Promise<EngineInfo[]> {
  const res = await fetch(`${API_BASE}/engines`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<EngineInfo[]>;
}

export async function search(request: SearchRequest): Promise<SearchResponseBody> {
  const res = await fetch(`${API_BASE}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<SearchResponseBody>;
}

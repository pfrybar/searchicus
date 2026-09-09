import { useEffect, useRef, useState, type FormEvent } from "react";
import { search, type SearchResponseBody } from "../api";
import { href } from "../router";

type Status = "idle" | "loading" | "error";

export function SearchPage({ urlQuery }: { urlQuery: string }) {
  const [query, setQuery] = useState(urlQuery);
  const [result, setResult] = useState<SearchResponseBody | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Cancels whatever request this page currently has open. */
  const inFlight = useRef<AbortController | null>(null);
  /**
   * The query this page has actually run.
   *
   * Both directions need it: a URL arriving with a query it has not run has
   * to run it, and submitting the same query twice must not run it twice —
   * the second submit changes no hash, so nothing else tells them apart.
   */
  const executed = useRef<string | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  // A search URL is a thing to paste and to reload, so opening one runs it.
  // An empty `q` leaves what is on screen alone: the URL has stopped naming a
  // search, which is not the same as asking for no results.
  useEffect(() => {
    const wanted = urlQuery.trim();
    if (!wanted || wanted === executed.current) return;
    setQuery(urlQuery);
    void runSearch(wanted);
  }, [urlQuery]);

  async function runSearch(text: string) {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    executed.current = text;
    setStatus("loading");
    setError(null);
    setResult(null);
    try {
      setResult(await search({ query: text }, controller.signal));
      setStatus("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Search failed");
      setStatus("error");
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;

    // The address bar carries the query, so a result can be shared and
    // survives a reload. The search runs from here rather than waiting on the
    // hash to change, because submitting the same query again changes nothing
    // about the hash and would otherwise do nothing at all.
    window.location.hash = href({ name: "search", query: text });
    void runSearch(text);
  }

  return (
    <section>
      <form className="search-form" onSubmit={handleSubmit}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the web…"
          aria-label="Search query"
          // The page exists to be typed into, and it is the landing route.
          autoFocus
        />
        <button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "Searching…" : "Search"}
        </button>
      </form>

      {/* A fan-out takes tens of seconds. Polite rather than assertive: it
          reports progress, and the failure below is what interrupts. */}
      <p className="result-summary" role="status">
        {status === "loading" ? "Searching every engine — this takes a few seconds…" : summarize(result)}
      </p>

      {status === "error" && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="results">
          {result.degraded && <p className="notice">Partial results: one or more sources were unavailable.</p>}
          {result.results.length > 0 ? (
            <ul>
              {result.results.map((item) => (
                <li key={item.url}>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  <p className="result-host">{hostOf(item.url)}</p>
                  {item.snippet && <p>{item.snippet}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No results.</p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * What came back, in one line.
 *
 * Count and elapsed time only: the public response is a deliberate projection
 * of the ranking, so per-engine attribution is not this page's to show. The
 * history pages are where a fan-out is taken apart.
 */
function summarize(result: SearchResponseBody | null): string {
  if (!result) return "";
  const plural = result.results.length === 1 ? "result" : "results";
  return `${result.results.length} ${plural} · ${(result.tookMs / 1000).toFixed(1)}s`;
}

/** The host alone, so a result can be placed before its title is read. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

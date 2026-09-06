import { useEffect, useRef, useState, type FormEvent } from "react";
import { extract, search, type ExtractResponseBody, type SearchResponseBody } from "../api";

type Status = "idle" | "loading" | "error";

/** The extraction panel's state, keyed by the result URL it belongs to. */
interface Extraction {
  url: string;
  status: "loading" | "ready" | "error";
  content?: ExtractResponseBody;
  error?: string;
}

export function SearchPage({ canExtract }: { canExtract: boolean }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponseBody | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  /** Cancels whatever request this page currently has open. */
  const inFlight = useRef<AbortController | null>(null);

  // Leaving the page cancels the request. A search holds a place in the
  // server's rate-limit queue and a browser page for as long as it runs, so
  // abandoning one silently costs the next person in line real time.
  useEffect(() => () => inFlight.current?.abort(), []);

  /** Replaces the open request with a fresh one, cancelling the old. */
  function startRequest(): AbortSignal {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    return controller.signal;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    const signal = startRequest();
    setStatus("loading");
    setError(null);
    setResult(null);
    setExtraction(null);
    try {
      const response = await search({ query }, signal);
      setResult(response);
      setStatus("idle");
    } catch (err) {
      // A cancelled request was replaced or abandoned on purpose. Reporting
      // it would put an error on screen for something the person just did.
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "Search failed");
      setStatus("error");
    }
  }

  async function handleExtract(url: string, offset?: number) {
    const signal = startRequest();
    setExtraction({ url, status: "loading" });
    try {
      const content = await extract({ url, ...(offset === undefined ? {} : { offset }) }, signal);
      setExtraction({ url, status: "ready", content });
    } catch (err) {
      if (signal.aborted) return;
      setExtraction({ url, status: "error", error: err instanceof Error ? err.message : "Extract failed" });
    }
  }

  return (
    <section>
      <form className="search-form" onSubmit={handleSubmit}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search query"
        />
        <button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "Searching…" : "Search"}
        </button>
      </form>

      {status === "error" && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="results">
          {result.degraded && <p className="error">Partial results: one or more sources were unavailable.</p>}
          {result.results.length > 0 ? (
            <ul>
              {result.results.map((item) => (
                <li key={item.url}>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  {item.snippet && <p>{item.snippet}</p>}
                  {canExtract && (
                    <button
                      type="button"
                      className="extract"
                      onClick={() => void handleExtract(item.url)}
                      disabled={extraction?.url === item.url && extraction.status === "loading"}
                    >
                      {extraction?.url === item.url && extraction.status === "loading" ? "Extracting…" : "Extract"}
                    </button>
                  )}
                  {extraction?.url === item.url && extraction.status === "error" && (
                    <p className="error" role="alert">
                      {extraction.error}
                    </p>
                  )}
                  {extraction?.url === item.url && extraction.status === "ready" && extraction.content && (
                    <div className="extraction">
                      <p className="untrusted">
                        Untrusted page content — {extraction.content.chars} characters
                        {extraction.content.truncated ? ` of ${extraction.content.totalChars}, truncated` : ""}
                      </p>
                      {/*
                        Rendered as preformatted text on purpose. This is
                        Markdown a stranger's website wrote; interpreting it as
                        HTML would hand that page the run of this one.
                      */}
                      <pre>{extraction.content.markdown}</pre>
                      {extraction.content.nextOffset !== undefined && (
                        <button
                          type="button"
                          className="extract"
                          onClick={() => void handleExtract(item.url, extraction.content?.nextOffset)}
                        >
                          Read on
                        </button>
                      )}
                    </div>
                  )}
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

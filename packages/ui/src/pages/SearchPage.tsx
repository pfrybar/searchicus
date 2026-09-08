import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  extract,
  find,
  outline,
  search,
  type ExtractResponseBody,
  type FindResponseBody,
  type OutlineResponseBody,
  type SearchResponseBody,
} from "../api";

type Status = "idle" | "loading" | "error";
type ReadKind = "outline" | "find" | "extract";

type PageRead =
  | { url: string; kind: ReadKind; status: "loading" }
  | { url: string; kind: "outline"; status: "ready"; content: OutlineResponseBody }
  | { url: string; kind: "find"; status: "ready"; content: FindResponseBody }
  | { url: string; kind: "extract"; status: "ready"; content: ExtractResponseBody }
  | { url: string; kind: ReadKind; status: "error"; error: string };

export function SearchPage({ canRead }: { canRead: boolean }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponseBody | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<PageRead | null>(null);
  /** Cancels whatever request this page currently has open. */
  const inFlight = useRef<AbortController | null>(null);

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
    setRead(null);
    try {
      const response = await search({ query }, signal);
      setResult(response);
      setStatus("idle");
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "Search failed");
      setStatus("error");
    }
  }

  async function handleOutline(url: string) {
    const signal = startRequest();
    setRead({ url, kind: "outline", status: "loading" });
    try {
      setRead({ url, kind: "outline", status: "ready", content: await outline({ url }, signal) });
    } catch (err) {
      if (!signal.aborted) setRead({ url, kind: "outline", status: "error", error: messageFor(err) });
    }
  }

  async function handleFind(url: string) {
    if (!result) return;
    const signal = startRequest();
    setRead({ url, kind: "find", status: "loading" });
    try {
      setRead({
        url,
        kind: "find",
        status: "ready",
        content: await find({ url, query: result.query.query }, signal),
      });
    } catch (err) {
      if (!signal.aborted) setRead({ url, kind: "find", status: "error", error: messageFor(err) });
    }
  }

  async function handleExtract(url: string, offset?: number) {
    const signal = startRequest();
    setRead({ url, kind: "extract", status: "loading" });
    try {
      setRead({
        url,
        kind: "extract",
        status: "ready",
        content: await extract({ url, ...(offset === undefined ? {} : { offset }) }, signal),
      });
    } catch (err) {
      if (!signal.aborted) setRead({ url, kind: "extract", status: "error", error: messageFor(err) });
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
                  {canRead && (
                    <div className="read-actions" aria-label={`Read ${item.title}`}>
                      <button
                        type="button"
                        className="extract"
                        onClick={() => void handleOutline(item.url)}
                        disabled={isLoading(read, item.url)}
                      >
                        {read?.url === item.url && read.kind === "outline" && read.status === "loading"
                          ? "Outlining…"
                          : "Outline"}
                      </button>
                      <button
                        type="button"
                        className="extract"
                        onClick={() => void handleFind(item.url)}
                        disabled={isLoading(read, item.url)}
                      >
                        {read?.url === item.url && read.kind === "find" && read.status === "loading"
                          ? "Finding…"
                          : "Find"}
                      </button>
                      <button
                        type="button"
                        className="extract"
                        onClick={() => void handleExtract(item.url)}
                        disabled={isLoading(read, item.url)}
                      >
                        {read?.url === item.url && read.kind === "extract" && read.status === "loading"
                          ? "Extracting…"
                          : "Extract"}
                      </button>
                    </div>
                  )}
                  {read?.url === item.url && <ReadPanel read={read} onExtract={handleExtract} />}
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

function ReadPanel({
  read,
  onExtract,
}: {
  read: PageRead;
  onExtract: (url: string, offset?: number) => Promise<void>;
}) {
  if (read.status === "loading") return <p className="meta">Reading page…</p>;
  if (read.status === "error")
    return (
      <p className="error" role="alert">
        {read.error}
      </p>
    );

  if (read.content.outcome === "unusable") {
    return (
      <div className="extraction error" role="alert">
        <strong>Page content unavailable</strong>
        <p>
          {read.content.reason}
          {read.content.httpStatus === undefined ? "" : ` · remote HTTP ${read.content.httpStatus}`}
          {read.content.cached ? " · served from cache" : ""}
        </p>
      </div>
    );
  }

  if (read.kind === "outline") {
    return (
      <div className="extraction">
        <p className="untrusted">Untrusted page title and headings</p>
        <p className="meta">
          {read.content.title} · {read.content.totalChars} characters
          {read.content.cached ? " · served from cache" : ""}
        </p>
        <ol className="outline-list">
          {read.content.sections.map((section) => (
            <li key={section.offset} style={{ marginLeft: `${section.depth * 1.25}rem` }}>
              {section.heading ?? "(untitled)"} <span className="meta">· {section.chars} chars</span>
              <button type="button" className="extract" onClick={() => void onExtract(read.url, section.offset)}>
                Read section
              </button>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (read.kind === "find") {
    return (
      <div className="extraction">
        <p className="untrusted">
          Untrusted page content — {read.content.matches.length} matching sections
          {read.content.cached ? " · served from cache" : ""}
        </p>
        {read.content.matches.length === 0 ? (
          <p className="meta">No matching sections found.</p>
        ) : (
          read.content.matches.map((match, index) => (
            <article key={`${match.offset}-${index}`}>
              <p className="meta">
                {match.path.join(" › ") || "(untitled)"} · {Math.round(match.coverage * 100)}% coverage
              </p>
              <pre>{match.markdown}</pre>
            </article>
          ))
        )}
      </div>
    );
  }

  const page = read.content;
  return (
    <div className="extraction">
      <p className="untrusted">
        Untrusted page content — {page.chars} characters
        {page.truncated ? ` of ${page.totalChars}, truncated` : ""}
        {page.cached ? " · served from cache" : ""}
      </p>
      <pre>{page.markdown}</pre>
      {page.nextOffset !== undefined && (
        <button type="button" className="extract" onClick={() => void onExtract(read.url, page.nextOffset)}>
          Read on
        </button>
      )}
    </div>
  );
}

function isLoading(read: PageRead | null, url: string): boolean {
  return read?.url === url && read.status === "loading";
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "Page read failed";
}

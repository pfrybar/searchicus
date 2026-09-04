import { useEffect, useState, type FormEvent } from "react";
import {
  extract,
  listEngines,
  search,
  type EngineInfo,
  type ExtractResponseBody,
  type SearchResponseBody,
} from "../api";

type Status = "idle" | "loading" | "error";

/** The extraction panel's state, keyed by the result ref it belongs to. */
interface Extraction {
  ref: string;
  status: "loading" | "ready" | "error";
  content?: ExtractResponseBody;
  error?: string;
}

export function SearchPage({ canExtract }: { canExtract: boolean }) {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponseBody | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);

  useEffect(() => {
    listEngines()
      .then(setEngines)
      .catch(() => setEngines([]));
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    setStatus("loading");
    setError(null);
    setResult(null);
    setExtraction(null);
    try {
      const response = await search({ query });
      setResult(response);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setStatus("error");
    }
  }

  async function handleExtract(ref: string, url: string) {
    setExtraction({ ref, status: "loading" });
    try {
      // The ref goes with the URL: it is what ties this read back to the
      // ranking that offered it, which is the signal the server is collecting.
      const content = await extract({ url, ref });
      setExtraction({ ref, status: "ready", content });
    } catch (err) {
      setExtraction({ ref, status: "error", error: err instanceof Error ? err.message : "Extract failed" });
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

      {engines.length > 0 && <p className="engines">Searching: {engines.map((engine) => engine.name).join(", ")}</p>}

      {status === "error" && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="results">
          {result.degraded && <p className="error">Partial results: one or more engines failed.</p>}
          {result.results.length > 0 ? (
            <ul>
              {result.results.map((item) => (
                <li key={item.ref}>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  <p>Ref: {item.ref}</p>
                  <p>Found by: {item.found.map(({ engineId }) => engineId).join(", ")}</p>
                  {item.snippet && <p>{item.snippet}</p>}
                  {canExtract && (
                    <button
                      type="button"
                      className="extract"
                      onClick={() => void handleExtract(item.ref, item.url)}
                      disabled={extraction?.ref === item.ref && extraction.status === "loading"}
                    >
                      {extraction?.ref === item.ref && extraction.status === "loading" ? "Extracting…" : "Extract"}
                    </button>
                  )}
                  {extraction?.ref === item.ref && extraction.status === "error" && (
                    <p className="error" role="alert">
                      {extraction.error}
                    </p>
                  )}
                  {extraction?.ref === item.ref && extraction.status === "ready" && extraction.content && (
                    <div className="extraction">
                      <p className="untrusted">
                        Untrusted page content
                        {extraction.content.truncated ? " (truncated)" : ""} — {extraction.content.chars} characters
                      </p>
                      {/*
                        Rendered as preformatted text on purpose. This is
                        Markdown a stranger's website wrote; interpreting it as
                        HTML would hand that page the run of this one.
                      */}
                      <pre>{extraction.content.markdown}</pre>
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

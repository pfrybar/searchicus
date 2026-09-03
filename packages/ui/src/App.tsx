import { useEffect, useState, type FormEvent } from "react";
import "./App.css";
import { listEngines, search, type EngineInfo, type SearchResponseBody } from "./api";

type Status = "idle" | "loading" | "error";

export function App() {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponseBody | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

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
    try {
      const response = await search({ query, limit: 10 });
      setResult(response);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setStatus("error");
    }
  }

  return (
    <main className="page">
      <h1>searchicus</h1>
      <p className="tagline">One query, every backend search engine.</p>

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
          {result.outcomes.map((outcome) => (
            <section key={outcome.engineId} className="engine-results">
              <h2>{outcome.engineId}</h2>
              {outcome.ok ? (
                outcome.response.results.length > 0 ? (
                  <ul>
                    {outcome.response.results.map((item) => (
                      <li key={item.url}>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          {item.title}
                        </a>
                        {item.snippet && <p>{item.snippet}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No results.</p>
                )
              ) : (
                <p className="error">{outcome.error}</p>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

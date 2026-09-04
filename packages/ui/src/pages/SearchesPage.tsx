import { useEffect, useState } from "react";
import { fetchSearches, type SearchSummaryBody } from "../api";
import { href } from "../router";

const PAGE_SIZE = 25;

export function SearchesPage() {
  const [searches, setSearches] = useState<SearchSummaryBody[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let current = true;
    fetchSearches({ limit: PAGE_SIZE })
      .then((page) => {
        if (!current) return;
        setSearches(page);
        setDone(page.length < PAGE_SIZE);
      })
      .catch((err: unknown) => current && setError(err instanceof Error ? err.message : "Could not load searches"))
      .finally(() => current && setLoading(false));

    return () => {
      current = false;
    };
  }, []);

  async function loadMore() {
    const cursor = searches.at(-1)?.searchId;
    if (!cursor) return;

    setLoading(true);
    try {
      const page = await fetchSearches({ limit: PAGE_SIZE, before: cursor });
      setSearches((current) => [...current, ...page]);
      setDone(page.length < PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more searches");
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <section>
        <h2>Searches</h2>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Searches</h2>
      {!loading && searches.length === 0 && <p className="meta">No searches archived yet.</p>}

      <ul className="search-list">
        {searches.map((search) => (
          <li key={search.searchId}>
            <a href={href({ name: "search-detail", searchId: search.searchId })} className="search-link">
              <span className="search-query">{search.query}</span>
            </a>
            <p className="meta">
              {new Date(search.startedAt).toLocaleString()} · {search.tookMs}ms ·{" "}
              {search.resultCount === null ? "no results returned" : `${search.resultCount} returned`}
              {search.extractions > 0 && ` · ${search.extractions} extracted`}
              {search.degraded && <span className="warn"> · degraded</span>}
              {search.status === "failed" && <span className="bad"> · every engine failed</span>}
            </p>
            <p className="engine-chips">
              {search.engines.map((engine) => (
                <span
                  key={engine.engineId}
                  className={engine.ok ? "chip ok" : "chip bad"}
                  title={engine.ok ? `${engine.tookMs}ms` : (engine.errorKind ?? "failed")}
                >
                  {engine.engineId} {engine.ok ? engine.resultCount : (engine.errorKind ?? "failed")}
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>

      {searches.length > 0 && !done && (
        <button type="button" className="more" onClick={() => void loadMore()} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

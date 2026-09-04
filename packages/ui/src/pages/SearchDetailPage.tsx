import { useEffect, useState } from "react";
import { fetchSearchDetail, type SearchDetailBody } from "../api";
import { href } from "../router";

export function SearchDetailPage({ searchId }: { searchId: string }) {
  const [detail, setDetail] = useState<SearchDetailBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    fetchSearchDetail(searchId)
      .then((next) => current && setDetail(next))
      .catch((err: unknown) => current && setError(err instanceof Error ? err.message : "Could not load that search"));

    return () => {
      current = false;
    };
  }, [searchId]);

  if (error) {
    return (
      <section>
        <p>
          <a href={href({ name: "searches" })}>← Searches</a>
        </p>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }

  if (!detail) return <p className="meta">Loading…</p>;

  /** Which engines found the result at a given merged rank. */
  const shown = new Set(detail.merged?.results.map((result) => result.url) ?? []);

  return (
    <section>
      <p>
        <a href={href({ name: "searches" })}>← Searches</a>
      </p>

      <h2 className="search-query">{detail.query}</h2>
      <p className="meta">
        {new Date(detail.startedAt).toLocaleString()} · {detail.tookMs}ms · {detail.searchId}
        {detail.degraded && <span className="warn"> · degraded</span>}
      </p>

      <h3>What the caller saw</h3>
      {detail.merged && detail.merged.results.length > 0 ? (
        <ol className="merged">
          {detail.merged.results.map((result) => {
            const extraction = detail.extractionDetails.find((entry) => entry.resultRef === result.ref);
            return (
              <li key={result.ref}>
                <a href={result.url} target="_blank" rel="noreferrer">
                  {result.title}
                </a>
                <p className="meta">
                  <code>{result.ref}</code> · score {result.score.toFixed(4)} · shown from {result.bestSource}
                  {extraction && (
                    <span className={extraction.status === "completed" ? "good" : "bad"}>
                      {" "}
                      · extracted{extraction.status === "failed" ? ` (${extraction.errorKind ?? "failed"})` : ""}
                    </span>
                  )}
                </p>
                <p className="engine-chips">
                  {result.found.map((finder) => (
                    <span key={finder.engineId} className="chip">
                      {finder.engineId} #{finder.rank}
                    </span>
                  ))}
                  {result.found.length === 1 && <span className="chip sole">only source</span>}
                </p>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="meta">Every engine failed, so nothing was returned.</p>
      )}

      <h3>What each engine returned</h3>
      <p className="meta">
        Each engine&rsquo;s own page, in its own order. Highlighted rows are the ones that survived into the merged list
        above.
      </p>
      <div className="engine-columns">
        {detail.engines.map((engine) => (
          <div key={engine.engineId} className="engine-column">
            <h4>
              {engine.engineId}
              <span className="meta">
                {engine.ok
                  ? ` ${engine.resultCount} results · ${engine.tookMs}ms${
                      engine.coverage === null ? "" : ` · coverage ${engine.coverage.toFixed(2)}`
                    }`
                  : ` failed · ${engine.errorKind ?? "unknown"}`}
              </span>
            </h4>

            {engine.ok ? (
              <ol className="engine-results">
                {engine.results.map((result, index) => (
                  <li key={`${result.url}-${index}`} className={shown.has(result.url) ? "made-the-cut" : undefined}>
                    <a href={result.url} target="_blank" rel="noreferrer" title={result.url}>
                      {result.title}
                    </a>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="error">{engine.error ?? "No diagnostic recorded."}</p>
            )}
          </div>
        ))}
      </div>

      {detail.extractionDetails.length > 0 && (
        <>
          <h3>Extractions</h3>
          <ul className="extraction-list">
            {detail.extractionDetails.map((extraction, index) => (
              <li key={`${extraction.createdAt}-${index}`}>
                <span className={extraction.status === "completed" ? "chip ok" : "chip bad"}>{extraction.status}</span>{" "}
                {extraction.title ?? extraction.requestedUrl}
                <p className="meta">
                  {extraction.resultRef ? <code>{extraction.resultRef}</code> : "URL only"} · {extraction.tookMs}ms
                  {extraction.chars !== null && ` · ${extraction.chars} chars`}
                  {extraction.errorKind && <span className="bad"> · {extraction.errorKind}</span>}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import { fetchEngineMetrics, type EngineMetricsBody } from "../api";
import type { EngineMetrics } from "@searchicus/core";

/** Windows an operator is likely to want, rather than a free-text box. */
const WINDOWS = [50, 200, 500, 2000];

export function MetricsPage() {
  const [window, setWindow] = useState(500);
  const [report, setReport] = useState<EngineMetricsBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    fetchEngineMetrics(window)
      .then((next) => {
        if (!current) return;
        setReport(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!current) return;
        setError(err instanceof Error ? err.message : "Could not load metrics");
        setReport(null);
      })
      .finally(() => current && setLoading(false));

    // A window change while a request is in flight must not let the older
    // response win the race and show numbers for a window nobody asked for.
    return () => {
      current = false;
    };
  }, [window]);

  if (error) {
    return (
      <section>
        <h2>Engine metrics</h2>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }

  const engines = report?.engines ?? [];
  const mostReturned = Math.max(1, ...engines.map((engine) => engine.returned));

  return (
    <section>
      <div className="page-head">
        <h2>Engine metrics</h2>
        <div className="window-picker">
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === window ? "chip active" : "chip"}
              onClick={() => setWindow(option)}
              aria-pressed={option === window}
            >
              last {option}
            </button>
          ))}
        </div>
      </div>

      {report && (
        <p className="meta">
          {report.window === 0
            ? "No searches archived yet."
            : `${report.window} of ${report.totalSearches} archived ${
                report.totalSearches === 1 ? "search" : "searches"
              }${report.since ? `, back to ${new Date(report.since).toLocaleString()}` : ""}.`}
        </p>
      )}

      {loading && !report && <p className="meta">Loading…</p>}

      {engines.length > 0 && (
        <div className="table-scroll">
          <table className="metrics">
            <thead>
              <tr>
                <th scope="col">Engine</th>
                <th scope="col">Ran</th>
                <th scope="col">Failed</th>
                <th scope="col">p50</th>
                <th scope="col">p95</th>
                <th scope="col">Results</th>
                <th scope="col">Coverage</th>
                <th scope="col">In merged list</th>
                <th scope="col">Shown as</th>
                <th scope="col">Only source</th>
                <th scope="col">Extracted</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((engine) => (
                <EngineRow key={engine.engineId} engine={engine} mostReturned={mostReturned} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="legend">
        <dt>In merged list</dt>
        <dd>Results this engine found that reached the caller.</dd>
        <dt>Shown as</dt>
        <dd>Results where it supplied the title and URL displayed.</dd>
        <dt>Only source</dt>
        <dd>
          Results <em>no other engine</em> found. The number that says whether an engine earns its seconds — one that
          always agrees with the others is cheap to drop.
        </dd>
        <dt>Extracted</dt>
        <dd>
          Results it found that someone later read in full. The closest thing here to a relevance judgement, with the
          caveat that it is a click model: rank 1 gets chosen more often whatever its quality.
        </dd>
      </dl>
    </section>
  );
}

function EngineRow({ engine, mostReturned }: { engine: EngineMetrics; mostReturned: number }) {
  const failureDetail = engine.failures.map((failure) => `${failure.kind}: ${failure.count}`).join(", ");

  return (
    <tr>
      <th scope="row">{engine.engineId}</th>
      <td>{engine.searches}</td>
      <td className={engine.failed > 0 ? "bad" : undefined} title={failureDetail || undefined}>
        {engine.failed}
        {engine.failed > 0 && <span className="failure-kinds"> {engine.failures[0]?.kind}</span>}
      </td>
      <td>{ms(engine.medianTookMs)}</td>
      <td>{ms(engine.p95TookMs)}</td>
      <td>{engine.meanResultCount ?? "—"}</td>
      <td>{engine.meanCoverage === null ? "—" : engine.meanCoverage.toFixed(2)}</td>
      <td>
        <span className="bar" style={{ width: `${(engine.returned / mostReturned) * 100}%` }} aria-hidden="true" />
        <span className="bar-value">{engine.returned}</span>
      </td>
      <td>{engine.bestSource}</td>
      <td className={engine.soleFinder > 0 ? "good" : undefined}>{engine.soleFinder}</td>
      <td>{engine.extracted}</td>
    </tr>
  );
}

function ms(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

import { useEffect, useState } from "react";
import { fetchEngineMetrics, type EngineMetricsBody } from "../api";
import type { EngineMetrics } from "@searchicus/core";

/** Windows an operator is likely to want, rather than a free-text box. */
const WINDOWS = [50, 200, 500, 2000];

/** A labelled number, with its own quiet subtitle. */
function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {detail && <div className="stat-detail">{detail}</div>}
    </div>
  );
}

/**
 * Totals for the window, above the per-engine table.
 *
 * Three groups, and the third is not like the other two. Searches and
 * extractions are read back from the archive over the same period. Overload
 * is a count this server process has been keeping since it started, because
 * work it refused never reached an engine or a page and archiving it would
 * put the server's own load into tables that describe engines and documents
 * — which it used to, and which made every engine read as broken. The label
 * says "since restart" because it is the one number here that does not
 * survive one.
 */
function Totals({ report }: { report: EngineMetricsBody }) {
  const { searches, extractions, overload } = report;
  const worstExtractFailure = extractions.failures[0];
  const turnedAway = overload
    ? overload.search.refused + overload.search.abandoned + overload.extract.refused + overload.extract.abandoned
    : 0;

  return (
    <div className="totals">
      <section className="total-group">
        <h3>Searches</h3>
        <div className="stats">
          <Stat label="completed" value={searches.completed} />
          <Stat
            label="degraded"
            value={searches.degraded}
            detail={searches.degraded > 0 ? "an engine was missing" : undefined}
          />
          <Stat label="failed" value={searches.failed} detail={searches.failed > 0 ? "every engine" : undefined} />
        </div>
      </section>

      <section className="total-group">
        <h3>Extractions</h3>
        {extractions.attempted === 0 ? (
          <p className="meta">None over this period.</p>
        ) : (
          <div className="stats">
            <Stat
              label="completed"
              value={extractions.completed}
              detail={`${extractions.domains} ${extractions.domains === 1 ? "host" : "hosts"}`}
            />
            <Stat
              label="unusable"
              value={extractions.unusable}
              detail={extractions.unusableReasons[0] ? `mostly ${extractions.unusableReasons[0].kind}` : undefined}
            />
            <Stat
              label="failed"
              value={extractions.failed}
              detail={worstExtractFailure ? `mostly ${worstExtractFailure.kind}` : undefined}
            />
            <Stat
              label="median read"
              value={extractions.medianTookMs === null ? "—" : `${(extractions.medianTookMs / 1000).toFixed(1)}s`}
              // Rendered reads only. A cached read is about a millisecond, so
              // a median over both would just drift down as the cache warms.
              detail={extractions.cached > 0 ? `${extractions.cached} served from cache` : "rendered"}
            />
          </div>
        )}
      </section>

      {overload && (
        <section className="total-group">
          <h3>
            Turned away <span className="stat-detail">since restart</span>
          </h3>
          {turnedAway === 0 ? (
            <p className="meta">Nothing refused. This server has kept up.</p>
          ) : (
            <div className="stats">
              <Stat
                label="searches"
                value={overload.search.refused + overload.search.abandoned}
                detail={`${overload.search.refused} refused, ${overload.search.abandoned} gave up waiting`}
              />
              <Stat
                label="extractions"
                value={overload.extract.refused + overload.extract.abandoned}
                detail={`${overload.extract.refused} refused, ${overload.extract.abandoned} gave up waiting`}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

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

      {report && report.window > 0 && <Totals report={report} />}

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

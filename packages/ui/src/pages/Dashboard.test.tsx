import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

/**
 * Routes by URL suffix rather than by call order, because the dashboard pages
 * fetch on mount and on navigation and the order is an implementation detail.
 */
function mockApi(routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = Object.keys(routes).find((candidate) => url.includes(candidate));
      if (!key) return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      const match = routes[key]!;
      return Promise.resolve(new Response(JSON.stringify(match.body), { status: match.status ?? 200 }));
    }),
  );
}

function engine(engineId: string, overrides: Record<string, unknown> = {}) {
  return {
    engineId,
    searches: 10,
    succeeded: 10,
    failed: 0,
    failures: [],
    medianTookMs: 1200,
    p95TookMs: 3400,
    meanResultCount: 9,
    meanCoverage: 0.95,
    meanMatch: 0.8,
    returned: 20,
    bestSource: 8,
    soleFinder: 2,
    extracted: 3,
    ...overrides,
  };
}

const HEALTH = { body: { status: "ok", extract: false, insights: true } };

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("dashboard navigation", () => {
  it("hides the dashboard links when no archive is configured", async () => {
    mockApi({ "/health": { body: { status: "ok", extract: false, insights: false } }, "/engines": { body: [] } });

    render(<App />);
    await screen.findByLabelText(/search query/i);

    // A link to a page that could only report 503 is worse than no link.
    expect(screen.queryByRole("link", { name: "Metrics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "History" })).not.toBeInTheDocument();
  });

  it("shows them when one is, and routes from the hash", async () => {
    mockApi({
      "/health": HEALTH,
      "/engines": { body: [] },
      "/metrics/engines": { body: { window: 10, totalSearches: 42, since: null, engines: [engine("bing")] } },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Metrics" }));

    expect(await screen.findByRole("heading", { name: /engine metrics/i })).toBeInTheDocument();
  });

  it("opens straight onto a deep-linked page", async () => {
    window.location.hash = "#/searches";
    mockApi({ "/health": HEALTH, "/engines": { body: [] }, "/searches": { body: { searches: [] } } });

    render(<App />);

    // Hash routing exists so a page like this can be pasted to someone
    // without the server needing a history fallback.
    expect(await screen.findByRole("heading", { name: "Searches" })).toBeInTheDocument();
  });
});

describe("metrics page", () => {
  beforeEach(() => {
    window.location.hash = "#/metrics";
  });

  it("shows each engine's reliability, speed, and contribution", async () => {
    mockApi({
      "/health": HEALTH,
      "/metrics/engines": {
        body: {
          window: 10,
          totalSearches: 42,
          since: "2026-09-04T16:00:00.000Z",
          engines: [engine("bing"), engine("brave", { failed: 2, failures: [{ kind: "timeout", count: 2 }] })],
        },
      },
    });

    render(<App />);

    const bing = within(await screen.findByRole("row", { name: /^bing/ }));
    expect(bing.getByText("1.2s")).toBeInTheDocument();
    expect(bing.getByText("3.4s")).toBeInTheDocument();
    expect(bing.getByText("0.95")).toBeInTheDocument();

    // The failing engine names its most common failure inline, so the table
    // says what went wrong and not merely that something did.
    expect(within(screen.getByRole("row", { name: /^brave/ })).getByText("timeout")).toBeInTheDocument();
    expect(screen.getByText(/10 of 42 archived searches/)).toBeInTheDocument();
  });

  it("refetches for a different window", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = input.toString();
        urls.push(url);
        const body = url.includes("/metrics/engines")
          ? { window: 50, totalSearches: 42, since: null, engines: [engine("bing")] }
          : { status: "ok", extract: false, insights: true };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "last 50" }));

    expect(await screen.findByText(/50 of 42/)).toBeInTheDocument();
    expect(urls.some((url) => url.includes("window=50"))).toBe(true);
  });

  it("says so when there is nothing archived yet", async () => {
    mockApi({
      "/health": HEALTH,
      "/metrics/engines": { body: { window: 0, totalSearches: 0, since: null, engines: [] } },
    });

    render(<App />);

    expect(await screen.findByText("No searches archived yet.")).toBeInTheDocument();
  });

  it("surfaces a failure instead of an empty table", async () => {
    mockApi({ "/health": HEALTH, "/metrics/engines": { status: 503, body: { error: "No search archive" } } });

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No search archive");
  });
});

describe("search history", () => {
  const summary = {
    searchId: "abc123",
    startedAt: "2026-09-04T16:00:00.000Z",
    query: "reciprocal rank fusion",
    status: "completed",
    degraded: false,
    tookMs: 8400,
    engineIds: ["bing", "brave"],
    resultCount: 3,
    extractions: 1,
    engines: [
      { engineId: "bing", ok: true, tookMs: 5477, resultCount: 7, coverage: 1, match: 1, errorKind: null },
      { engineId: "brave", ok: false, tookMs: 900, resultCount: 0, coverage: null, match: null, errorKind: "timeout" },
    ],
  };

  it("lists searches with each engine's outcome at a glance", async () => {
    window.location.hash = "#/searches";
    mockApi({ "/health": HEALTH, "/searches": { body: { searches: [summary] } } });

    render(<App />);

    expect(await screen.findByText("reciprocal rank fusion")).toBeInTheDocument();
    expect(screen.getByText("bing 7")).toBeInTheDocument();
    expect(screen.getByText("brave timeout")).toBeInTheDocument();
    expect(screen.getByText(/3 returned/)).toBeInTheDocument();
    expect(screen.getByText(/1 extracted/)).toBeInTheDocument();
  });

  it("shows what each engine returned beside what the caller saw", async () => {
    window.location.hash = "#/searches/abc123";
    mockApi({
      "/health": HEALTH,
      "/searches/abc123": {
        body: {
          ...summary,
          merged: {
            searchId: "abc123",
            query: { query: "reciprocal rank fusion" },
            tookMs: 8400,
            degraded: false,
            results: [
              {
                ref: "abc123-1",
                title: "RRF explained",
                url: "https://a.test/rrf",
                score: 0.049,
                bestSource: "bing",
                found: [
                  { engineId: "bing", rank: 1 },
                  { engineId: "brave", rank: 2 },
                ],
                families: ["bing", "brave"],
              },
            ],
          },
          engines: [
            {
              engineId: "bing",
              ok: true,
              tookMs: 5477,
              resultCount: 2,
              coverage: 1,
              match: 1,
              errorKind: null,
              results: [
                { title: "RRF explained", url: "https://a.test/rrf", source: "bing" },
                { title: "Something bing alone had", url: "https://b.test/x", source: "bing" },
              ],
            },
            {
              engineId: "brave",
              ok: false,
              tookMs: 900,
              resultCount: 0,
              coverage: null,
              match: null,
              errorKind: "timeout",
              error: `Engine "brave" timed out`,
              results: [],
            },
          ],
          extractionDetails: [
            {
              createdAt: "2026-09-04T16:01:00.000Z",
              resultRef: "abc123-1",
              requestedUrl: "https://a.test/rrf",
              finalUrl: "https://a.test/rrf",
              status: "completed",
              errorKind: null,
              title: "RRF explained",
              chars: 4812,
              tookMs: 7300,
            },
          ],
        },
      },
    });

    render(<App />);

    // The merged list, with who found it and at what rank. The ref shows up
    // twice on purpose: once in the ranking, once against the extraction made
    // from it.
    expect(await screen.findAllByText("abc123-1")).toHaveLength(2);
    expect(screen.getByText("bing #1")).toBeInTheDocument();
    expect(screen.getByText("brave #2")).toBeInTheDocument();

    // Each engine's own page, including the one that returned nothing and why.
    const bingColumn = screen.getByRole("heading", { name: /bing/ }).parentElement!;
    expect(within(bingColumn).getByText("Something bing alone had")).toBeInTheDocument();
    expect(screen.getByText(/timed out/)).toBeInTheDocument();

    // And what someone actually read afterwards.
    expect(screen.getByText(/4812 chars/)).toBeInTheDocument();
  });

  it("reports a search that was never archived", async () => {
    window.location.hash = "#/searches/nope";
    mockApi({ "/health": HEALTH, "/searches/nope": { status: 404, body: { error: "No such search" } } });

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No such search");
  });
});

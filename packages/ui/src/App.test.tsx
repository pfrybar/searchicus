import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function mockFetchSequence(responses: Array<{ url: string; status?: number; body: unknown }>) {
  const remaining = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const index = remaining.findIndex((response) => url.endsWith(response.url));
      if (index === -1) throw new Error(`Unexpected fetch: ${url}`);
      const [match] = remaining.splice(index, 1);
      if (!match) throw new Error(`Missing mocked response for: ${url}`);
      return Promise.resolve(new Response(JSON.stringify(match.body), { status: match.status ?? 200 }));
    }),
  );
}

function searchResponse() {
  return {
    query: { query: "cats" },
    tookMs: 1,
    degraded: false,
    results: [{ title: "Cats 101", url: "https://example.com/cats", snippet: "All about cats" }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("App", () => {
  it("renders generic search results on submit", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", body: searchResponse() },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("Cats 101")).toBeInTheDocument();
    expect(screen.queryByText(/Ref:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Found by:/)).not.toBeInTheDocument();
  });

  it("says what came back, and where each result is from", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", body: { ...searchResponse(), tookMs: 8432 } },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");

    // Count and elapsed time only: the public response is a projection of the
    // ranking, so per-engine attribution is not this page's to show.
    expect(screen.getByRole("status")).toHaveTextContent("1 result · 8.4s");
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("clears stale results when a subsequent search fails", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", body: searchResponse() },
      { url: "/api/search", status: 502, body: { error: "Search unavailable" } },
    ]);

    render(<App />);
    const input = screen.getByLabelText(/search query/i);
    fireEvent.change(input, { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByText("Cats 101")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "dogs" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Search unavailable");
    expect(screen.queryByText("Cats 101")).not.toBeInTheDocument();
  });

  it("puts the query in the address bar, so a result can be pasted or reloaded", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", body: searchResponse() },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats and dogs" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");

    expect(window.location.hash).toBe("#/?q=cats+and+dogs");
    // One search, not two: the hash change must not re-run what the submit
    // already ran, and the mocked sequence has nothing left to answer with.
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/search"))).toHaveLength(1);
  });

  it("runs the query a pasted URL arrives with", async () => {
    window.location.hash = "#/?q=cats";
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", body: searchResponse() },
    ]);

    render(<App />);

    // Nothing was typed and nothing was clicked: the URL named a search, and
    // a search URL that does not search is a broken link.
    expect(await screen.findByText("Cats 101")).toBeInTheDocument();
    expect(screen.getByLabelText(/search query/i)).toHaveValue("cats");
  });

  it("shows an error message when the search request fails", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", status: 500, body: { error: "boom" } },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

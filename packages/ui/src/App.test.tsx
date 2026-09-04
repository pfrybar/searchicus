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
    searchId: "abc123",
    query: { query: "cats" },
    tookMs: 1,
    degraded: false,
    results: [
      {
        ref: "abc123-1",
        title: "Cats 101",
        url: "https://example.com/cats",
        snippet: "All about cats",
        score: 0.1,
        bestSource: "test",
        found: [{ engineId: "test", rank: 1 }],
        families: ["test"],
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("loads engines, then renders merged search results on submit", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/engines", body: [{ id: "test", name: "Test Search Engine" }] },
      { url: "/api/search", body: searchResponse() },
    ]);

    render(<App />);

    await screen.findByText(/Test Search Engine/);

    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("Cats 101")).toBeInTheDocument();
    expect(screen.getByText("Ref: abc123-1")).toBeInTheDocument();
    expect(screen.getByText("Found by: test")).toBeInTheDocument();
  });

  it("clears stale results when a subsequent search fails", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/engines", body: [] },
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

  it("offers no Extract action when the server will not extract", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/engines", body: [] },
      { url: "/api/search", body: searchResponse() },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");

    // A control that could only ever return 503 is worse than no control.
    expect(screen.queryByRole("button", { name: /extract/i })).not.toBeInTheDocument();
  });

  it("extracts a result and shows its content as text, not as markup", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: true } },
      { url: "/api/engines", body: [] },
      { url: "/api/search", body: searchResponse() },
      {
        url: "/api/extract",
        body: {
          url: "https://example.com/cats",
          finalUrl: "https://example.com/cats",
          ref: "abc123-1",
          title: "Cats 101",
          markdown: "# Cats\n\n<script>alert(1)</script> and some prose.",
          truncated: false,
          chars: 47,
          tookMs: 800,
          untrusted: true,
        },
      },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");

    fireEvent.click(await screen.findByRole("button", { name: /extract/i }));

    // Rendered verbatim: this is Markdown a stranger's website wrote, and
    // interpreting it as HTML would hand that page the run of this one.
    const panel = await screen.findByText(/and some prose/);
    expect(panel.textContent).toContain("<script>alert(1)</script>");
    expect(panel.querySelector("script")).toBeNull();
    expect(screen.getByText(/untrusted page content/i)).toBeInTheDocument();
  });

  it("shows why an extraction failed without losing the result list", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: true } },
      { url: "/api/engines", body: [] },
      { url: "/api/search", body: searchResponse() },
      { url: "/api/extract", status: 502, body: { error: "That page could not be loaded." } },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");

    fireEvent.click(await screen.findByRole("button", { name: /extract/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That page could not be loaded.");
    expect(screen.getByText("Cats 101")).toBeInTheDocument();
  });

  it("shows an error message when the search request fails", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/engines", body: [] },
      { url: "/api/search", status: 500, body: { error: "boom" } },
    ]);

    render(<App />);

    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

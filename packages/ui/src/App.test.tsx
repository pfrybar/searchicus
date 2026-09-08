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

  it("offers no Extract action when the server will not extract", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: false } },
      { url: "/api/search", body: searchResponse() },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");
    expect(screen.queryByRole("button", { name: /extract/i })).not.toBeInTheDocument();
  });

  it("outlines and finds within a result without exposing provider details", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: true } },
      { url: "/api/search", body: searchResponse() },
      {
        url: "/api/outline",
        body: {
          outcome: "usable",
          url: "https://example.com/cats",
          finalUrl: "https://example.com/cats",
          title: "Cats 101",
          totalChars: 200,
          navigable: true,
          sections: [{ heading: "Care", depth: 0, offset: 0, chars: 180 }],
          tookMs: 20,
          untrusted: true,
        },
      },
      {
        url: "/api/find",
        body: {
          outcome: "usable",
          url: "https://example.com/cats",
          finalUrl: "https://example.com/cats",
          title: "Cats 101",
          query: "cats",
          totalChars: 200,
          navigable: true,
          tookMs: 10,
          untrusted: true,
          matches: [
            {
              path: ["Care"],
              offset: 0,
              coverage: 1,
              markdown: "## Care\n\nCats need care.",
              chars: 24,
              sectionChars: 24,
              truncated: false,
            },
          ],
        },
      },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText("Cats 101");

    fireEvent.click(screen.getByRole("button", { name: /^outline$/i }));
    expect(await screen.findByText("Care", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/untrusted page title and headings/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^find$/i }));
    expect(await screen.findByText("Cats need care.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/untrusted page content/i)).toBeInTheDocument();
  });

  it("extracts a result and shows its content as text, not as markup", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: true } },
      { url: "/api/search", body: searchResponse() },
      {
        url: "/api/extract",
        body: {
          outcome: "usable",
          url: "https://example.com/cats",
          finalUrl: "https://example.com/cats",
          title: "Cats 101",
          markdown: "# Cats\n\n<script>alert(1)</script> and some prose.",
          truncated: false,
          chars: 47,
          totalChars: 47,
          offset: 0,
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

    const panel = await screen.findByText(/and some prose/);
    expect(panel.textContent).toContain("<script>alert(1)</script>");
    expect(panel.querySelector("script")).toBeNull();
    expect(screen.getByText(/untrusted page content/i)).toBeInTheDocument();
  });

  it("shows an unusable-page warning and never renders withheld content", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: true } },
      { url: "/api/search", body: searchResponse() },
      {
        url: "/api/extract",
        body: {
          outcome: "unusable",
          reason: "access_denied",
          url: "https://example.com/cats",
          finalUrl: "https://example.com/cats",
          httpStatus: 403,
          tookMs: 20,
        },
      },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Cats 101");
    fireEvent.click(await screen.findByRole("button", { name: /extract/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Page content unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("access_denied · remote HTTP 403");
    expect(screen.queryByText(/untrusted page content/i)).not.toBeInTheDocument();
  });

  it("shows why an extraction failed without losing the result list", async () => {
    mockFetchSequence([
      { url: "/api/health", body: { status: "ok", extract: true } },
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
      { url: "/api/search", status: 500, body: { error: "boom" } },
    ]);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

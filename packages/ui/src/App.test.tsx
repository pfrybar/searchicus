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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("loads engines, then renders search results on submit", async () => {
    mockFetchSequence([
      { url: "/api/engines", body: [{ id: "test", name: "Test Search Engine" }] },
      {
        url: "/api/search",
        body: {
          query: { query: "cats" },
          outcomes: [
            {
              engineId: "test",
              ok: true,
              response: {
                engine: "test",
                query: { query: "cats" },
                tookMs: 1,
                results: [
                  { title: "Cats 101", url: "https://example.com/cats", source: "test", snippet: "All about cats" },
                ],
              },
            },
          ],
        },
      },
    ]);

    render(<App />);

    await screen.findByText(/Test Search Engine/);

    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("Cats 101")).toBeInTheDocument();
  });

  it("clears stale results when a subsequent search fails", async () => {
    mockFetchSequence([
      { url: "/api/engines", body: [] },
      {
        url: "/api/search",
        body: {
          query: { query: "cats" },
          outcomes: [
            {
              engineId: "test",
              ok: true,
              response: {
                engine: "test",
                query: { query: "cats" },
                tookMs: 1,
                results: [{ title: "Cats 101", url: "https://example.com/cats", source: "test" }],
              },
            },
          ],
        },
      },
      { url: "/api/search", status: 500, body: { error: "boom" } },
    ]);

    render(<App />);
    const input = screen.getByLabelText(/search query/i);

    fireEvent.change(input, { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByText("Cats 101")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "dogs" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText("Cats 101")).not.toBeInTheDocument();
  });

  it("shows an error message when the search request fails", async () => {
    mockFetchSequence([
      { url: "/api/engines", body: [] },
      { url: "/api/search", status: 500, body: { error: "boom" } },
    ]);

    render(<App />);

    fireEvent.change(screen.getByLabelText(/search query/i), { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

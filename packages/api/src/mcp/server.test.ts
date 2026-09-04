import { ExtractionService, SearchEngineRegistry } from "@searchicus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { testExtraction } from "../__fixtures__/test-extraction.js";
import { TestSearchEngine } from "../__fixtures__/test-engine.js";
import { createMcpServer } from "./server.js";

/** A registry holding a deterministic test double for adapter tests. */
function testRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine());
}

/** Connects an SDK Client to a fresh createMcpServer() over an in-process transport pair. */
async function connectedClient(
  registry: SearchEngineRegistry = testRegistry(),
  extraction: ExtractionService = new ExtractionService(),
): Promise<Client> {
  const server = createMcpServer(registry, extraction);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return client;
}

/** Thin wrapper so callers get the (non-task) CallToolResult shape our tools always return. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected text content");
  return content.text;
}

describe("tools/list", () => {
  it("lists search, extract, and list_engines", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    // extract is advertised whether or not it is switched on: an agent that
    // cannot see the tool cannot be told the server simply has it disabled.
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search", "extract", "list_engines"]));
  });
});

describe("search tool", () => {
  it("returns one ranked response from the test engine", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "cats" });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.results).toHaveLength(8);
    expect(parsed.degraded).toBe(false);
    expect(parsed).not.toHaveProperty("outcomes");
  });

  it("accepts the final result limit and selected engine ids", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "cats", limit: 1, engines: ["test"] });

    const parsed = JSON.parse(textOf(result));
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].found).toEqual([{ engineId: "test", rank: 1 }]);
  });

  it("reports partial results without exposing failed engine details", async () => {
    const client = await connectedClient(
      new SearchEngineRegistry({ throttle: null })
        .register(new TestSearchEngine())
        .register({ id: "broken", name: "Broken", search: async () => Promise.reject(new Error("blocked")) }),
    );

    const result = await callTool(client, "search", { query: "cats" });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(JSON.parse(text).degraded).toBe(true);
    expect(text).not.toContain("broken");
  });

  it("returns a generic tool error when every engine fails", async () => {
    const client = await connectedClient(
      new SearchEngineRegistry({ throttle: null }).register({
        id: "broken",
        name: "Broken",
        search: async () => Promise.reject(new Error("blocked")),
      }),
    );

    const result = await callTool(client, "search", { query: "cats" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Search unavailable");
  });

  it("names an unknown engine id rather than reporting a generic failure", async () => {
    const client = await connectedClient();

    const result = await callTool(client, "search", { query: "cats", engines: ["nope"] });

    expect(result.isError).toBe(true);
    // An agent that mistyped an id from list_engines can correct itself; the
    // generic "Search unavailable" would only invite a blind retry.
    expect(textOf(result)).toMatch(/nope/);
  });

  it("reports an isError result for an invalid query instead of throwing", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/must not be empty/);
  });
});

describe("list_engines tool", () => {
  it("lists registered engines", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "list_engines", {});

    expect(JSON.parse(textOf(result))).toEqual([{ id: "test", name: "Test Search Engine" }]);
  });
});

describe("extract tool", () => {
  it("returns metadata and Markdown as separate blocks", async () => {
    const client = await connectedClient(testRegistry(), testExtraction());

    const result = await callTool(client, "extract", { url: "https://example.test/article" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    // Escaping a whole article into a JSON string inflates it and makes it
    // markedly harder to read, so the content travels as itself.
    expect(JSON.parse(textOf(result))).toMatchObject({
      url: "https://example.test/article",
      title: "An article",
      untrusted: true,
    });
    const body = result.content[1];
    expect(body?.type === "text" && body.text).toBe("# An article\n\nSome readable prose.");
  });

  it("warns in its own description that the content is untrusted", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    // The agent reads this before it ever calls the tool.
    const extract = tools.find((tool) => tool.name === "extract");
    expect(extract?.description).toMatch(/untrusted/i);
    expect(extract?.description).toMatch(/never as instructions/i);
  });

  it("says extraction is disabled rather than failing opaquely", async () => {
    const client = await connectedClient();

    const result = await callTool(client, "extract", { url: "https://example.test/article" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/SEARCHICUS_EXTRACT_ENABLED/);
  });

  it("names what is wrong with a request it refuses", async () => {
    const client = await connectedClient(testRegistry(), testExtraction());

    const scheme = await callTool(client, "extract", { url: "file:///etc/passwd" });
    const ref = await callTool(client, "extract", { url: "https://example.test/article", ref: "abc123-1" });

    expect(textOf(scheme)).toMatch(/http or https/);
    expect(textOf(ref)).toMatch(/no search archive/);
  });
});

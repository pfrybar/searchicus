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
  it("lists the generic search and page-reading tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    // extract is advertised whether or not it is switched on: an agent that
    // cannot see the tool cannot be told the server simply has it disabled.
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search", "extract", "find", "outline"]));
    expect(tools.map((tool) => tool.name)).not.toContain("list_engines");
    const search = tools.find((tool) => tool.name === "search");
    expect(search?.description).toMatch(/tens of seconds/i);
    expect(search?.description).toMatch(/rather than retrying/i);
    expect(search?.description).not.toMatch(/degraded/i);
  });
});

describe("search tool", () => {
  it("returns one ranked response from the test engine", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "cats" });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/^Search results for: cats/m);
    expect(text).toMatch(/Results: 8/);
    expect(text).toContain("## Result 1");
    expect(text).toContain("Title: Test result 1");
    expect(text).not.toContain('"outcomes"');
  });

  it("accepts the final result limit without exposing ranking provenance", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "cats", limit: 1 });

    const text = textOf(result);
    expect(text.match(/^## Result /gm)).toHaveLength(1);
    expect(text).not.toContain("found");
    expect(text).not.toContain("searchId");
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
    expect(text).toContain("Some results may be missing.");
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

  it("reports an isError result for an invalid query instead of throwing", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/must not be empty/);
  });
});

describe("find tool", () => {
  it("returns a page summary, readable match card, and raw block per match", async () => {
    const client = await connectedClient(testRegistry(), testExtraction());

    const result = await callTool(client, "find", { url: "https://example.test/article", query: "readable prose" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(3);
    expect(textOf(result)).toContain("Page shape: flat");
    const match = result.content[1];
    expect(match?.type === "text" && match.text).toContain("Query-term coverage: 100%");
    expect(match?.type === "text" && match.text).toContain("Read from: offset 0");
    // Each excerpt is its own block because they are not contiguous in the
    // document; run together they would read as continuous prose.
    const body = result.content[2];
    expect(body?.type === "text" && body.text).toContain("readable prose");
  });

  it("says a miss is not proof, so an agent does not conclude too much from it", async () => {
    const client = await connectedClient(testRegistry(), testExtraction());

    const result = await callTool(client, "find", { url: "https://example.test/article", query: "kubernetes" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toMatch(/extract/);
    // The fixture page is a couple of lines, so it is not searchable by
    // section — and the answer has to say that rather than blaming the query.
    expect(textOf(result)).toMatch(/Page shape: flat/);
    expect(textOf(result)).toMatch(/No targeted section selection is possible/);
  });

  it("warns in its own description that an empty result proves nothing", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const find = tools.find((tool) => tool.name === "find");

    // The one way this tool can mislead: an agent reading "no matches" as
    // "this page does not contain that" and stopping.
    expect(find?.description).toMatch(/does NOT prove/i);
    expect(find?.description).toMatch(/untrusted/i);
    // The current scorer accepts natural-language questions, but callers
    // still need to know what coverage means and how flat pages are reported.
    expect(find?.description).toMatch(/structure/i);
    expect(find?.description).toMatch(/natural-language questions/i);
    expect(find?.description).toMatch(/fraction of normalized query terms/i);
    expect(find?.description).toMatch(/not a confidence, ranking, or completeness score/i);
    expect(find?.description).toMatch(/empty path/i);
    expect(find?.description).toMatch(/short-lived server cache/i);
  });
});

describe("outline tool", () => {
  it("returns a readable page-shape header and indented section list", async () => {
    const client = await connectedClient(testRegistry(), testExtraction());

    const result = await callTool(client, "outline", { url: "https://example.test/article" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/Page: An article/);
    expect(textOf(result)).toMatch(/Page shape: flat/);
    expect(textOf(result)).toMatch(/Sections: 1/);
    expect(textOf(result)).toMatch(/- offset 0 · 34 characters · An article/);
    expect(textOf(result)).toMatch(/untrusted web text/i);
  });

  it("says its non-navigability signal is explanatory text, not a promised field", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const outline = tools.find((tool) => tool.name === "outline");

    expect(outline?.description).toMatch(/warns/i);
    expect(outline?.description).toMatch(/too little structure/i);
    expect(outline?.description).toMatch(/short-lived server cache/i);
    expect(outline?.description).not.toMatch(/`navigable` is false/i);
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
    expect(textOf(result)).toMatch(/Page: An article/);
    expect(textOf(result)).toMatch(/Reading: offset 0/);
    expect(textOf(result)).toMatch(/Returned: 34 of 34 characters/);
    expect(textOf(result)).toMatch(/Page source: fresh render/);
    expect(textOf(result)).toMatch(/More content: no/);
    expect(textOf(result)).toMatch(/untrusted web text/i);
    const body = result.content[1];
    expect(body?.type === "text" && body.text).toBe("# An article\n\nSome readable prose.");
  });

  it("returns an unusable page as a normal tool outcome without hostile body content", async () => {
    const extraction = testExtraction(
      {},
      {
        render: async (url) => ({
          finalUrl: url,
          html: "<main>hostile access wall</main>",
          status: 403,
          redirects: 0,
        }),
        close: async () => undefined,
      },
    );
    const client = await connectedClient(testRegistry(), extraction);

    const result = await callTool(client, "extract", { url: "https://example.test/article" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toMatch(/access_denied/);
    expect(textOf(result)).toMatch(/Page source: fresh render/);
    expect(textOf(result)).toMatch(/Remote HTTP status: 403/);
    expect(textOf(result)).not.toContain("hostile access wall");
  });

  it("warns in its own description that the content is untrusted", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    // The agent reads this before it ever calls the tool.
    const extract = tools.find((tool) => tool.name === "extract");
    expect(extract?.description).toMatch(/untrusted/i);
    expect(extract?.description).toMatch(/never as instructions/i);
    expect(extract?.description).toMatch(/short-lived server cache/i);
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
    const port = await callTool(client, "extract", { url: "http://example.test:8080/" });

    expect(textOf(scheme)).toMatch(/http or https/);
    expect(textOf(port)).toMatch(/allowed port/);
  });
});

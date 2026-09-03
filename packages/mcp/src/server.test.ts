import { createDefaultRegistry, type SearchEngineRegistry } from "@searchicus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";

/** Connects an SDK Client to a fresh createMcpServer() over an in-process transport pair. */
async function connectedClient(registry: SearchEngineRegistry = createDefaultRegistry()): Promise<Client> {
  const server = createMcpServer(registry);
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
  it("lists search and list_engines", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search", "list_engines"]));
  });
});

describe("search tool", () => {
  it("returns results from the mock engine", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "cats", limit: 2 });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0].engineId).toBe("mock");
    expect(parsed.outcomes[0].response.results).toHaveLength(2);
  });

  it("can target a specific subset of engines", async () => {
    const client = await connectedClient();
    const result = await callTool(client, "search", { query: "cats", engines: ["mock"] });

    const parsed = JSON.parse(textOf(result));
    expect(parsed.outcomes.map((o: { engineId: string }) => o.engineId)).toEqual(["mock"]);
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

    expect(JSON.parse(textOf(result))).toEqual([{ id: "mock", name: "Mock Search Engine" }]);
  });
});

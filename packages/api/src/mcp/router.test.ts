import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MockSearchEngine, SearchEngineRegistry } from "@searchicus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

/**
 * A registry holding only the mock engine. These tests exercise the adapter
 * layer, not whichever engines happen to be registered by default — pinning
 * the roster here keeps them stable as engines are added, and browser-free
 * however those engines behave.
 */
function mockOnlyRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry({ throttle: null }).register(new MockSearchEngine());
}

async function startServer(): Promise<{ server: Server; url: URL }> {
  const server = createApp(mockOnlyRegistry()).listen(0);
  await once(server, "listening");

  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Server did not expose an address");

  return { server, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function textOf(result: CallToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected text content");
  return content.text;
}

describe("Streamable HTTP endpoint", () => {
  it("serves MCP tool calls over the stateless HTTP transport", async () => {
    const { server, url } = await startServer();
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "http-test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const result = (await client.callTool({
        name: "search",
        arguments: { query: "cats", limit: 2 },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result)).outcomes[0].response.results).toHaveLength(2);
    } finally {
      await transport.close();
      await stopServer(server);
    }
  });

  it("shares one registry with the search API, so both list the same engines", async () => {
    const app = createApp(mockOnlyRegistry());

    const viaApi = await request(app).get("/engines");
    const viaMcp = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_engines", arguments: {} } });

    expect(viaApi.body).toEqual([{ id: "mock", name: "Mock Search Engine" }]);
    expect(viaMcp.status).toBe(200);
    expect(viaMcp.text).toContain("Mock Search Engine");
  });

  it("rejects GET and DELETE, which stateless mode can't support", async () => {
    const app = createApp(mockOnlyRegistry());

    for (const res of [await request(app).get("/mcp"), await request(app).delete("/mcp")]) {
      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe(-32000);
    }
  });

  it("answers a malformed body with a JSON-RPC parse error, not the API's error shape", async () => {
    const res = await request(createApp(mockOnlyRegistry()))
      .post("/mcp")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  });
});

describe("with MCP disabled", () => {
  it("404s the endpoint while leaving the search API intact", async () => {
    const app = createApp(mockOnlyRegistry(), { mcp: false });

    const mcp = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(mcp.status).toBe(404);
    expect(mcp.body).toEqual({ error: "Not found" });

    const engines = await request(app).get("/engines");
    expect(engines.status).toBe(200);
  });
});

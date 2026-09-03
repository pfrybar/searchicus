import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

async function startServer(): Promise<{ server: Server; url: URL }> {
  const server = createApp().listen(0);
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
});

import type { SearchEngineRegistry } from "@searchicus/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response } from "express";
import { createMcpServer, createRegistry } from "./server.js";

/**
 * Builds the Express app hosting the MCP Streamable HTTP endpoint at
 * POST /mcp, in stateless mode: every request gets its own McpServer and
 * transport, so there's no session state to manage between requests. This
 * is the simplest correct way to serve MCP over HTTP; a stateful variant
 * (persistent sessions, server-initiated notifications) can layer on top
 * of the same `createMcpServer` later without changing it.
 */
export function createApp(registry: SearchEngineRegistry = createRegistry()): Express {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const server = createMcpServer(registry);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no sessions, so it can't support the GET
  // (server-initiated stream) or DELETE (session teardown) parts of the
  // Streamable HTTP spec.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

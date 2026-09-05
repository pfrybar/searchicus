import { causeOf, createLogger, ExtractionService, type SearchEngineRegistry } from "@searchicus/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type Request, type Response } from "express";
import { createMcpServer } from "./server.js";

const log = createLogger("mcp");

/**
 * The MCP Streamable HTTP endpoint, mounted at /mcp by createApp().
 *
 * Stateless mode: every request gets its own McpServer and transport, so
 * there's no session state to manage between requests. That's what makes
 * MCP mountable as an ordinary router alongside the search API rather than
 * needing a process of its own — a stateful variant (persistent sessions,
 * server-initiated notifications) could still layer on top of the same
 * `createMcpServer` later.
 *
 * Sharing the API's process is deliberate: both surfaces then share one
 * registry, and therefore one rate-limit throttle and one browser profile.
 * Run as separate processes they would each throttle independently and hit
 * the backends at twice the configured rate.
 */
export function createMcpRouter(
  registry: SearchEngineRegistry,
  extraction: ExtractionService = new ExtractionService(),
): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    try {
      const server = createMcpServer(registry, extraction);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("error handling MCP request", { cause: causeOf(err) });
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
  router.get("/", methodNotAllowed);
  router.delete("/", methodNotAllowed);

  return router;
}

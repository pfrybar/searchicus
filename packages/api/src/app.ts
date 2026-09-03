import { createDefaultRegistry, SearchEngineRegistry, SearchRequestSchema } from "@searchicus/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createMcpRouter } from "./mcp/router.js";

/** Path the MCP Streamable HTTP endpoint is mounted at, when enabled. */
const MCP_PATH = "/mcp";

export interface CreateAppOptions {
  /**
   * Serve the MCP Streamable HTTP endpoint at POST /mcp. Defaults to true.
   *
   * MCP shares this process rather than running as its own service so that
   * both surfaces share one registry — and therefore one rate-limit throttle
   * and one persistent browser profile. Two processes would throttle
   * independently and query the backends at twice the configured rate.
   */
  mcp?: boolean;
}

/**
 * Builds the Express app. Takes a registry so tests can inject their own
 * (see app.test.ts) instead of depending on module-level state. Defaults to
 * core's shared default registry — see AGENTS.md for how to wire up real
 * backends.
 */
export function createApp(
  registry: SearchEngineRegistry = createDefaultRegistry(),
  options: CreateAppOptions = {},
): Express {
  const { mcp = true } = options;
  const app = express();
  app.use(express.json());

  // Must be mounted before the catch-all 404 below, which would otherwise
  // swallow every MCP request.
  if (mcp) app.use(MCP_PATH, createMcpRouter(registry));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/engines", (_req, res) => {
    res.json(registry.list().map((engine) => ({ id: engine.id, name: engine.name })));
  });

  app.post("/search", async (req, res) => {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid search request", details: parsed.error.issues });
      return;
    }

    const { engines, ...query } = parsed.data;
    const outcomes = await registry.searchAll(query, engines);
    res.json({ query, outcomes });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Express recognizes error-handling middleware by its 4-argument arity.
  // Only malformed JSON is a client error; unexpected failures must not be
  // mislabeled as a 400 or expose implementation details.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    // Body parsing happens upstream of the MCP router, so its failures land
    // here rather than in that router's own handler. MCP clients expect
    // JSON-RPC error objects, not this API's `{ error }` shape.
    if (isMcpRequest(req)) {
      const malformed = isMalformedJsonError(err);
      if (!malformed) console.error("Unhandled MCP error:", err);
      res.status(malformed ? 400 : 500).json({
        jsonrpc: "2.0",
        error: malformed
          ? { code: -32700, message: "Parse error" }
          : { code: -32603, message: "Internal server error" },
        id: null,
      });
      return;
    }

    if (isMalformedJsonError(err)) {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    console.error("Unhandled API error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function isMalformedJsonError(err: unknown): boolean {
  return err instanceof SyntaxError && (err as { status?: unknown }).status === 400;
}

/** True for requests aimed at the MCP endpoint, path-only (query string stripped). */
function isMcpRequest(req: Request): boolean {
  return (req.originalUrl.split("?")[0] ?? "") === MCP_PATH;
}

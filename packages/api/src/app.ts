import {
  AllEnginesFailedError,
  createDefaultRegistry,
  ExtractFailedError,
  ExtractionDisabledError,
  ExtractionService,
  ExtractRequestError,
  ExtractRequestSchema,
  SearchEngineRegistry,
  SearchRequestSchema,
  UnknownEngineError,
} from "@searchicus/core";
import express, { Router, type Express, type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { createMcpRouter } from "./mcp/router.js";

/** Path the MCP Streamable HTTP endpoint is mounted at, when enabled. */
const MCP_PATH = "/mcp";

/**
 * The built UI, resolved relative to this module — which lands on
 * packages/ui/dist whether this runs from src/ (vitest) or dist/ (node),
 * since both sit one level under the package root.
 */
export function defaultUiDir(): string {
  return fileURLToPath(new URL("../../ui/dist/", import.meta.url));
}

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
  /**
   * Serve the built web UI as static files. `true` uses defaultUiDir();
   * a string serves that directory instead. Defaults to false so tests and
   * library callers don't depend on whether the UI happens to be built —
   * the server entry point turns it on when a build is present.
   *
   * There is deliberately no SPA history fallback: the UI is a single page
   * with no client-side router, and a catch-all would turn genuine API 404s
   * into HTML. Add one (scoped to non-API paths) if routing arrives.
   */
  ui?: boolean | string;
  /**
   * Serves POST /extract. Defaults to a service with no renderer, which
   * exists and always refuses — the endpoint is deliberately present in every
   * deployment so a caller learns extraction is switched off rather than
   * meeting a bare 404 they cannot interpret.
   */
  extraction?: ExtractionService;
}

/**
 * Builds the Express app. Takes a registry so tests can inject their own
 * (see app.test.ts) instead of depending on module-level state. Its default
 * is core's browser-free registry, which can list engines but reports a
 * generic unavailable search when every browser-backed engine fails. The
 * executable server entry point injects createBrowserRegistry("api").
 */
export function createApp(
  registry: SearchEngineRegistry = createDefaultRegistry(),
  options: CreateAppOptions = {},
): Express {
  const { mcp = true, ui = false, extraction = new ExtractionService() } = options;
  const app = express();
  app.use(express.json());

  // Must be mounted before the catch-all 404 below, which would otherwise
  // swallow every MCP request.
  if (mcp) app.use(MCP_PATH, createMcpRouter(registry, extraction));

  // Mounted twice on purpose. The UI calls /api/* so that it works
  // same-origin in production without a build-time API URL baked in, while
  // the root paths keep the existing contract (README curl examples, every
  // existing test) working unchanged.
  const search = createSearchRouter(registry, extraction);
  app.use("/api", search);
  app.use(search);

  // After the API routes, so a stray file in the UI build can never shadow
  // an endpoint; before the 404, so index.html is reachable at /.
  if (ui) app.use(express.static(typeof ui === "string" ? ui : defaultUiDir()));

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

/** The search and extract endpoints, mounted at both / and /api. */
function createSearchRouter(registry: SearchEngineRegistry, extraction: ExtractionService): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    // `extract` is here so the UI can hide an action that would only ever
    // fail, and so an operator can confirm the toggle took effect without
    // making a request that renders something.
    res.json({ status: "ok", extract: extraction.enabled });
  });

  router.get("/engines", (_req, res) => {
    res.json(registry.list().map((engine) => ({ id: engine.id, name: engine.name })));
  });

  router.post("/search", async (req, res, next) => {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid search request", details: parsed.error.issues });
      return;
    }

    try {
      res.json(await registry.search(parsed.data));
    } catch (err) {
      // A bad engine id is the caller's mistake, so it must not share the 502
      // that means "the backends are down". GET /engines already lists every
      // id, so naming the unknown one discloses nothing.
      if (err instanceof UnknownEngineError) {
        res.status(400).json({ error: "Invalid search request", details: [err.message] });
        return;
      }
      if (err instanceof AllEnginesFailedError) {
        res.status(502).json({ error: "Search unavailable" });
        return;
      }
      next(err);
    }
  });

  router.post("/extract", async (req, res, next) => {
    const parsed = ExtractRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid extract request", details: parsed.error.issues });
      return;
    }

    try {
      res.json(await extraction.extract(parsed.data));
    } catch (err) {
      // Three distinct answers, because they call for three different
      // reactions: fix the request, ask an operator, or try again later.
      if (err instanceof ExtractRequestError) {
        res.status(400).json({ error: "Invalid extract request", details: [err.message] });
        return;
      }
      if (err instanceof ExtractionDisabledError) {
        res.status(503).json({ error: err.message });
        return;
      }
      // Already written to be safe to return verbatim; see ExtractFailedError.
      if (err instanceof ExtractFailedError) {
        res.status(502).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

function isMalformedJsonError(err: unknown): boolean {
  return err instanceof SyntaxError && (err as { status?: unknown }).status === 400;
}

/** True for requests aimed at the MCP endpoint, path-only (query string stripped). */
function isMcpRequest(req: Request): boolean {
  return (req.originalUrl.split("?")[0] ?? "") === MCP_PATH;
}

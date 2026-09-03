import { MockSearchEngine, SearchEngineRegistry, SearchRequestSchema } from "@searchicus/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

/**
 * Builds the registry the API searches against. Real backends aren't wired
 * up yet (see AGENTS.md) — this is the one place that would change to
 * register them.
 */
export function createRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry().register(new MockSearchEngine());
}

/**
 * Builds the Express app. Takes a registry so tests can inject their own
 * (see app.test.ts) instead of depending on module-level state.
 */
export function createApp(registry: SearchEngineRegistry = createRegistry()): Express {
  const app = express();
  app.use(express.json());

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
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
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

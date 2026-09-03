import { MockSearchEngine, SearchEngineRegistry, SearchQuerySchema } from "@searchicus/core";
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
    const parsed = SearchQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid search query", details: parsed.error.issues });
      return;
    }

    const engineIds = Array.isArray((req.body as { engines?: unknown })?.engines)
      ? (req.body as { engines: string[] }).engines
      : undefined;

    const outcomes = await registry.searchAll(parsed.data, engineIds);
    res.json({ query: parsed.data, outcomes });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Express recognizes error-handling middleware by its 4-argument arity —
  // this is what catches express.json()'s malformed-body SyntaxErrors.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid request" });
  });

  return app;
}

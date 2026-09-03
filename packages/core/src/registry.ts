import type { SearchEngine, SearchQuery, SearchResponse } from "./types.js";

export class UnknownEngineError extends Error {
  constructor(public readonly engineId: string) {
    super(`No search engine registered with id "${engineId}"`);
    this.name = "UnknownEngineError";
  }
}

/** One engine's outcome within a fan-out search. */
export type EngineSearchOutcome =
  | { engineId: string; ok: true; response: SearchResponse }
  | { engineId: string; ok: false; error: string };

/**
 * Holds the set of available SearchEngine backends and fans a query out to
 * one or many of them. This is the seam real backends plug into later —
 * every front door (CLI/API/MCP/UI) talks to a registry, never to an
 * engine directly.
 */
export class SearchEngineRegistry {
  private readonly engines = new Map<string, SearchEngine>();

  /** Register an engine, replacing any previous engine with the same id. */
  register(engine: SearchEngine): this {
    this.engines.set(engine.id, engine);
    return this;
  }

  get(id: string): SearchEngine | undefined {
    return this.engines.get(id);
  }

  has(id: string): boolean {
    return this.engines.has(id);
  }

  list(): SearchEngine[] {
    return [...this.engines.values()];
  }

  /** Search one specific engine by id. Throws UnknownEngineError if unregistered. */
  async search(engineId: string, query: SearchQuery): Promise<SearchResponse> {
    const engine = this.engines.get(engineId);
    if (!engine) throw new UnknownEngineError(engineId);
    return engine.search(query);
  }

  /**
   * Fan a query out to multiple engines in parallel (default: every
   * registered engine) and report each one's outcome, including failures,
   * rather than rejecting the whole call when one engine errors.
   */
  async searchAll(
    query: SearchQuery,
    engineIds: string[] = this.list().map((engine) => engine.id),
  ): Promise<EngineSearchOutcome[]> {
    return Promise.all(
      engineIds.map(async (engineId): Promise<EngineSearchOutcome> => {
        try {
          const response = await this.search(engineId, query);
          return { engineId, ok: true, response };
        } catch (err) {
          return { engineId, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }
}

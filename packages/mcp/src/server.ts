import { MockSearchEngine, SearchEngineRegistry, SearchQuerySchema } from "@searchicus/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Builds the registry the MCP server searches against. Real backends
 * aren't wired up yet (see AGENTS.md) — this is the one place that would
 * change to register them.
 */
export function createRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry().register(new MockSearchEngine());
}

/**
 * Builds an McpServer exposing the registry as MCP tools. app.ts creates a
 * fresh server (and transport) per HTTP request — stateless mode — so this
 * is cheap to call repeatedly rather than something to share/cache.
 */
export function createMcpServer(registry: SearchEngineRegistry = createRegistry()): McpServer {
  const server = new McpServer({ name: "searchicus", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      title: "Search",
      description: "Search one or more backend search engines and return matching results.",
      inputSchema: {
        ...SearchQuerySchema.shape,
        engines: z
          .array(z.string())
          .optional()
          .describe("Specific engine ids to search; defaults to every registered engine."),
      },
    },
    async ({ engines, ...query }) => {
      const outcomes = await registry.searchAll(query, engines);
      return {
        content: [{ type: "text", text: JSON.stringify({ query, outcomes }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_engines",
    {
      title: "List engines",
      description: "List the backend search engines currently registered.",
    },
    async () => {
      const engines = registry.list().map((engine) => ({ id: engine.id, name: engine.name }));
      return { content: [{ type: "text", text: JSON.stringify(engines, null, 2) }] };
    },
  );

  return server;
}

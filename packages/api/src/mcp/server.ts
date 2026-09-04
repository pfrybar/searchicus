import {
  AllEnginesFailedError,
  createDefaultRegistry,
  SearchEngineRegistry,
  SearchRequestSchema,
  UnknownEngineError,
} from "@searchicus/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Builds an McpServer exposing the registry as MCP tools. app.ts creates a
 * fresh server (and transport) per HTTP request — stateless mode — so this
 * is cheap to call repeatedly rather than something to share/cache. Its
 * default is core's browser-free registry, which can list engines but cannot
 * run browser-backed searches; the executable server injects a browser-backed
 * registry.
 */
export function createMcpServer(registry: SearchEngineRegistry = createDefaultRegistry()): McpServer {
  const server = new McpServer({ name: "searchicus", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      title: "Search",
      description: "Search one or more backend search engines and return matching results.",
      inputSchema: SearchRequestSchema.shape,
    },
    async (request) => {
      try {
        const response = await registry.search(request);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        // Name the bad id: an agent that picked it from list_engines can
        // correct itself, where a generic failure invites a blind retry.
        if (err instanceof UnknownEngineError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        if (err instanceof AllEnginesFailedError) {
          return { isError: true, content: [{ type: "text", text: "Search unavailable" }] };
        }
        throw err;
      }
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

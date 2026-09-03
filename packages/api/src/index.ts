import { createBrowserRegistry } from "@searchicus/core/browser";
import { createApp } from "./app.js";
import { shutdownOn } from "./shutdown.js";

const port = Number(process.env.PORT ?? 3000);

// MCP is served from this process by default. Disabling it leaves the
// search API untouched; see CreateAppOptions for why they share a process.
const mcp = !["false", "0", "no"].includes((process.env.MCP_ENABLED ?? "").toLowerCase());

const registry = createBrowserRegistry("api");
const server = createApp(registry, { mcp }).listen(port, () => {
  console.log(`searchicus API listening on http://localhost:${port}`);
  console.log(mcp ? `  MCP (Streamable HTTP) at http://localhost:${port}/mcp` : "  MCP endpoint disabled");
});

shutdownOn(server, registry);

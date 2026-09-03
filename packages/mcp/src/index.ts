import { createBrowserRegistry } from "@searchicus/core/browser";
import { createApp } from "./app.js";
import { shutdownOn } from "./shutdown.js";

const port = Number(process.env.PORT ?? 3001);
const registry = createBrowserRegistry("mcp");
const server = createApp(registry).listen(port, () => {
  console.log(`searchicus MCP server (Streamable HTTP) listening on http://localhost:${port}/mcp`);
});

shutdownOn(server, registry);

import { createBrowserRegistry } from "@searchicus/core/browser";
import { createApp } from "./app.js";
import { shutdownOn } from "./shutdown.js";

const port = Number(process.env.PORT ?? 3000);
const registry = createBrowserRegistry("api");
const server = createApp(registry).listen(port, () => {
  console.log(`searchicus API listening on http://localhost:${port}`);
});

shutdownOn(server, registry);

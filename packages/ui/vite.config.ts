import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Lets the UI call same-origin `/api/*` in dev without dealing with
      // CORS. The API serves those same paths under /api, so there's no
      // rewrite here and dev and production hit identical URLs — in
      // production the API serves the built UI itself, same-origin.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});

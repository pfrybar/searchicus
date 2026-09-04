import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SearchEngineRegistry } from "@searchicus/core";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { TestSearchEngine } from "./__fixtures__/test-engine.js";
import { createApp } from "./app.js";

/** A registry holding a deterministic test double for adapter tests. */
function testRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine());
}

/**
 * A stand-in for packages/ui/dist, so these tests don't depend on the UI
 * having been built (or on what it contains).
 */
const uiDir = mkdtempSync(path.join(tmpdir(), "searchicus-ui-"));
writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>searchicus</title><div id=root></div>");
writeFileSync(path.join(uiDir, "app.js"), "// bundle");

afterAll(() => rmSync(uiDir, { recursive: true, force: true }));

const withUi = () => createApp(testRegistry(), { ui: uiDir });

describe("static UI", () => {
  it("serves index.html at the root", async () => {
    const res = await request(withUi()).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("searchicus");
  });

  it("serves other build assets", async () => {
    const res = await request(withUi()).get("/app.js");
    expect(res.status).toBe(200);
  });

  it("still 404s unknown paths as JSON — there is no SPA catch-all", async () => {
    const res = await request(withUi()).get("/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("is off by default, so / 404s when the UI isn't enabled", async () => {
    const res = await request(createApp(testRegistry())).get("/");
    expect(res.status).toBe(404);
  });
});

describe("search API mount points", () => {
  it("answers under /api, which is what the UI calls", async () => {
    const app = withUi();

    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
    expect((await request(app).get("/api/engines")).body).toEqual([{ id: "test", name: "Test Search Engine" }]);

    const search = await request(app).post("/api/search").send({ query: "cats" });
    expect(search.status).toBe(200);
    expect(search.body.results[0].found).toEqual([{ engineId: "test", rank: 1 }]);
    expect(search.body).not.toHaveProperty("outcomes");
  });

  it("still answers at the root, keeping the existing contract", async () => {
    const app = withUi();

    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
    const search = await request(app).post("/search").send({ query: "cats" });
    expect(search.status).toBe(200);
  });

  it("keeps API routes ahead of static files, so a build can't shadow them", async () => {
    // A UI build containing a file literally named `engines` must not win.
    writeFileSync(path.join(uiDir, "engines"), "static file, not the API");

    const res = await request(withUi()).get("/engines");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "test", name: "Test Search Engine" }]);
  });

  it("serves MCP alongside the UI", async () => {
    const res = await request(withUi())
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_engines", arguments: {} } });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Test Search Engine");
  });
});

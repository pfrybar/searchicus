import { SearchEngineRegistry } from "@searchicus/core";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { TestSearchEngine } from "./__fixtures__/test-engine.js";
import { createApp } from "./app.js";

/**
 * A registry holding only a deterministic test double. These tests exercise
 * the adapter layer, not whichever engines happen to be registered by default.
 */
function testRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry({ throttle: null }).register(new TestSearchEngine());
}

function testApp() {
  return createApp(testRegistry());
}

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await request(testApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /engines", () => {
  it("lists registered engines", async () => {
    const res = await request(testApp()).get("/engines");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "test", name: "Test Search Engine" }]);
  });
});

describe("POST /search", () => {
  it("returns one ranked response by default", async () => {
    const res = await request(testApp()).post("/search").send({ query: "cats" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ query: { query: "cats" }, degraded: false });
    expect(res.body.searchId).toMatch(/^[0-9a-z]{13}$/);
    expect(res.body.results).toHaveLength(8);
    expect(res.body.results[0].ref).toBe(`${res.body.searchId}-1`);
    expect(res.body).not.toHaveProperty("outcomes");
  });

  it("applies the requested final result limit", async () => {
    const res = await request(testApp()).post("/search").send({ query: "cats", limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it("can target a specific subset of engines", async () => {
    const res = await request(testApp())
      .post("/search")
      .send({ query: "cats", engines: ["test"] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].found).toEqual([{ engineId: "test", rank: 1 }]);
  });

  it("marks partial results as degraded without revealing the failed engine", async () => {
    const registry = new SearchEngineRegistry({ throttle: null })
      .register(new TestSearchEngine())
      .register({ id: "broken", name: "Broken", search: async () => Promise.reject(new Error("blocked")) });

    const res = await request(createApp(registry)).post("/search").send({ query: "cats" });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body).not.toHaveProperty("outcomes");
    expect(JSON.stringify(res.body)).not.toContain("broken");
  });

  it("reports total engine failure without exposing backend details", async () => {
    const registry = new SearchEngineRegistry({ throttle: null }).register({
      id: "broken",
      name: "Broken",
      search: async () => Promise.reject(new Error("blocked")),
    });

    const res = await request(createApp(registry)).post("/search").send({ query: "cats" });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Search unavailable" });
  });

  it("rejects an invalid request body", async () => {
    const missingQuery = await request(testApp()).post("/search").send({});
    const invalidLimit = await request(testApp()).post("/search").send({ query: "cats", limit: 0 });
    const whitespaceQuery = await request(testApp()).post("/search").send({ query: "   " });
    const malformedEngines = await request(testApp())
      .post("/search")
      .send({ query: "cats", engines: ["test", 1] });

    for (const res of [missingQuery, invalidLimit, whitespaceQuery, malformedEngines]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid search request");
      expect(res.body.details).toBeInstanceOf(Array);
    }
  });

  it("rejects malformed JSON bodies", async () => {
    const res = await request(testApp()).post("/search").set("Content-Type", "application/json").send("{not json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    const res = await request(testApp()).get("/nope");
    expect(res.status).toBe(404);
  });
});

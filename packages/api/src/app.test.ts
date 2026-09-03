import { MockSearchEngine, SearchEngineRegistry } from "@searchicus/core";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

function testApp() {
  return createApp(new SearchEngineRegistry().register(new MockSearchEngine()));
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
    expect(res.body).toEqual([{ id: "mock", name: "Mock Search Engine" }]);
  });
});

describe("POST /search", () => {
  it("returns results from every registered engine by default", async () => {
    const res = await request(testApp()).post("/search").send({ query: "cats", limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(1);
    expect(res.body.outcomes[0].engineId).toBe("mock");
    expect(res.body.outcomes[0].response.results).toHaveLength(2);
  });

  it("can target a specific subset of engines", async () => {
    const res = await request(testApp())
      .post("/search")
      .send({ query: "cats", engines: ["mock"] });

    expect(res.status).toBe(200);
    expect(res.body.outcomes.map((o: { engineId: string }) => o.engineId)).toEqual(["mock"]);
  });

  it("rejects a request missing a query", async () => {
    const res = await request(testApp()).post("/search").send({ limit: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects malformed JSON bodies", async () => {
    const res = await request(testApp()).post("/search").set("Content-Type", "application/json").send("{not json");

    expect(res.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    const res = await request(testApp()).get("/nope");
    expect(res.status).toBe(404);
  });
});

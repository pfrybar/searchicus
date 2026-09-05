import { describe, expect, it } from "vitest";
import { envOptIn, envOptOut } from "./env.js";

describe("envOptIn", () => {
  it("stays off until an operator says yes", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on", " on "]) {
      expect(envOptIn(value), value).toBe(true);
    }
    for (const value of [undefined, "", "false", "0", "no", "off", "tru", "y"]) {
      expect(envOptIn(value), String(value)).toBe(false);
    }
  });
});

describe("envOptOut", () => {
  it("stays on until an operator says no", () => {
    for (const value of [undefined, "", "true", "1", "yes", "on", "anything"]) {
      expect(envOptOut(value), String(value)).toBe(true);
    }
    for (const value of ["false", "FALSE", "0", "no", "off", " off "]) {
      expect(envOptOut(value), value).toBe(false);
    }
  });
});

describe("the two policies", () => {
  it("read the same words the same way, and differ only in their default", () => {
    // The bug behind sharing a vocabulary: SEARCHICUS_STORE=0 used to leave
    // archiving on, because that switch understood only the literal "false"
    // while MCP_ENABLED=0 beside it meant off.
    expect(envOptIn(undefined)).toBe(false);
    expect(envOptOut(undefined)).toBe(true);
    for (const value of ["true", "1", "yes", "on"]) {
      expect(envOptIn(value) && envOptOut(value), value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(envOptIn(value) || envOptOut(value), value).toBe(false);
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { causeOf, createLogger, getLogLevel, logEnabled, setLogLevel, setLogSink } from "./logger.js";

const lines: string[] = [];
function capture(level: Parameters<typeof setLogLevel>[0]) {
  lines.length = 0;
  setLogSink((line) => void lines.push(line));
  setLogLevel(level);
}

afterEach(() => {
  setLogLevel("silent");
  setLogSink((line) => process.stderr.write(`${line}\n`));
});

describe("createLogger", () => {
  it("writes level, scope, message and fields on one line", () => {
    capture("debug");
    createLogger("engine").warn("engine failed", { engine: "bing", kind: "timeout", tookMs: 30001 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z WARN {2}engine {4}engine failed /);
    expect(lines[0]).toContain("engine=bing");
    expect(lines[0]).toContain("kind=timeout");
    expect(lines[0]).toContain("tookMs=30001");
  });

  it("keeps a line greppable however ugly the value is", () => {
    capture("debug");
    const log = createLogger("x");
    log.info("m", { multi: "one\ntwo\tthree", spaced: "a b", err: new Error("boom"), missing: undefined, nul: null });

    const line = lines[0] ?? "";
    // A log line that spans lines is a log line that cannot be grepped.
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain('multi="one two three"');
    expect(line).toContain('spaced="a b"');
    expect(line).toContain("err=boom");
    expect(line).not.toContain("missing=");
    expect(line).toContain("nul=null");
  });

  it("honours the level, and silent means silent", () => {
    capture("warn");
    const log = createLogger("x");
    log.debug("no");
    log.info("no");
    log.warn("yes");
    log.error("yes");
    expect(lines).toHaveLength(2);

    capture("silent");
    createLogger("x").error("not even this");
    expect(lines).toHaveLength(0);
    expect(logEnabled("error")).toBe(false);
  });

  it("reports the level it is running at", () => {
    capture("info");
    expect(getLogLevel()).toBe("info");
    expect(logEnabled("debug")).toBe(false);
    expect(logEnabled("info")).toBe(true);
  });
});

describe("causeOf", () => {
  it("unwraps a chain into something one line can carry", () => {
    const root = new Error("connect ECONNREFUSED");
    const middle = new Error("navigation failed", { cause: root });
    const top = new Error("That URL could not be extracted.", { cause: middle });

    expect(causeOf(top)).toBe(
      "Error: That URL could not be extracted. <- Error: navigation failed <- Error: connect ECONNREFUSED",
    );
  });

  it("survives a cycle and a non-error", () => {
    const a = new Error("a");
    a.cause = a;
    expect(causeOf(a)).toBe("Error: a");
    expect(causeOf("just a string")).toBe("just a string");
    expect(causeOf(undefined)).toBeUndefined();
  });
});

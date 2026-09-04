import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  buildStealthOptions,
  buildUserAgent,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  FALLBACK_CHROMIUM_MAJOR,
  LAUNCH_ARGS,
  resolveChromiumMajor,
  STEALTH_INIT,
  VIEWPORT,
} from "./stealth.js";

const savedEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...savedEnv };
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("buildUserAgent", () => {
  it("names the major it was given and never says Headless", () => {
    const ua = buildUserAgent("151");
    expect(ua).toContain("Chrome/151.0.0.0");
    expect(ua).not.toContain("Headless");
  });

  it("claims the X11 Linux platform the container actually runs", () => {
    expect(buildUserAgent("151")).toContain("(X11; Linux x86_64)");
  });
});

describe("resolveChromiumMajor", () => {
  /** A stand-in binary that prints `output` and exits 0. */
  function fakeBinary(output: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "searchicus-version-"));
    tempDirs.push(dir);
    const file = path.join(dir, "chrome");
    writeFileSync(file, `#!/bin/sh\necho ${JSON.stringify(output)}\n`, { mode: 0o755 });
    return file;
  }

  it("parses the major out of a real --version line", async () => {
    await expect(resolveChromiumMajor(fakeBinary("Google Chrome for Testing 151.0.7922.34"))).resolves.toBe("151");
  });

  it("handles a plain Chromium version line", async () => {
    await expect(resolveChromiumMajor(fakeBinary("Chromium 138.0.7204.157"))).resolves.toBe("138");
  });

  it("falls back when the binary prints nothing parseable", async () => {
    await expect(resolveChromiumMajor(fakeBinary("no version here"))).resolves.toBe(FALLBACK_CHROMIUM_MAJOR);
  });

  it("falls back rather than throwing when the binary is missing", async () => {
    // A browser that cannot be interrogated is about to fail at launch with a
    // far better error than this function could produce.
    await expect(resolveChromiumMajor("/nonexistent/chrome")).resolves.toBe(FALLBACK_CHROMIUM_MAJOR);
  });

  it("reads the real Playwright binary when one is installed", async () => {
    const { chromium } = await import("playwright");
    let executablePath: string;
    try {
      executablePath = chromium.executablePath();
    } catch {
      return; // No browser installed; the fallback paths above still cover this.
    }

    const major = await resolveChromiumMajor(executablePath);
    expect(major).toMatch(/^\d+$/);
  });
});

describe("buildStealthOptions", () => {
  it("selects the full Chromium binary, not the headless shell", () => {
    // Load-bearing. The default headless binary has no window.chrome, an
    // empty plugin list, no media devices and no WebGPU adapter, none of
    // which an init script can convincingly add.
    expect(buildStealthOptions().channel).toBe("chromium");
  });

  it("turns automation control off at the source and leaves the sandbox on", () => {
    const args = buildStealthOptions().args ?? [];
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).not.toContain("--no-sandbox");
    expect(args).toEqual(LAUNCH_ARGS);
  });

  it("does not fabricate Client Hints — Chromium's own stay self-consistent", () => {
    expect(buildStealthOptions().extraHTTPHeaders).toBeUndefined();
  });

  it("threads the major through to the user agent", () => {
    expect(buildStealthOptions({ major: "142" }).userAgent).toContain("Chrome/142.0.0.0");
  });

  it("defaults the time zone and locale, and lets the environment override them", () => {
    expect(buildStealthOptions()).toMatchObject({ timezoneId: DEFAULT_TIMEZONE, locale: DEFAULT_LOCALE });

    process.env.SEARCHICUS_TIMEZONE = "Europe/Berlin";
    process.env.SEARCHICUS_LOCALE = "de-DE";
    expect(buildStealthOptions()).toMatchObject({ timezoneId: "Europe/Berlin", locale: "de-DE" });
  });

  it("prefers an explicit argument over the environment", () => {
    process.env.SEARCHICUS_TIMEZONE = "Europe/Berlin";
    expect(buildStealthOptions({ timezoneId: "Asia/Tokyo" }).timezoneId).toBe("Asia/Tokyo");
  });

  it("grants the permissions a used browser would have, but not clipboard-read", () => {
    const permissions = buildStealthOptions().permissions ?? [];
    expect(permissions).toContain("notifications");
    expect(permissions).not.toContain("clipboard-read");
  });

  it("uses a viewport that is not a common automation default", () => {
    expect(buildStealthOptions().viewport).toEqual({ ...VIEWPORT });
    expect(VIEWPORT).not.toEqual({ width: 1280, height: 720 });
    expect(VIEWPORT).not.toEqual({ width: 800, height: 600 });
  });
});

describe("STEALTH_INIT", () => {
  it("reports an inner size that matches the viewport option", () => {
    // These drifting apart is exactly the kind of contradiction the whole
    // file exists to avoid, so they are generated from one constant.
    expect(STEALTH_INIT).toContain(`const IN = [${VIEWPORT.width}, ${VIEWPORT.height}]`);
  });

  it("keeps outer larger than inner, and the screen larger than outer", () => {
    const [inner, outer, screen] = [...STEALTH_INIT.matchAll(/const (?:IN|OUT|SCREEN) = \[(\d+), (\d+)\]/g)].map(
      (match) => [Number(match[1]), Number(match[2])] as const,
    );

    expect(inner && outer && screen).toBeTruthy();
    expect(outer![1]).toBeGreaterThan(inner![1]); // title bar and tab strip
    expect(screen![0]).toBeGreaterThanOrEqual(outer![0]);
    expect(screen![1]).toBeGreaterThan(outer![1]); // an unmaximized window
  });

  it("leaves navigator accessors native", () => {
    // Redefining these is a stronger signal than any value it would hide.
    expect(STEALTH_INIT).not.toMatch(/defineProperty\(\s*navigator/);
    expect(STEALTH_INIT).not.toMatch(/def\(navigator,/);
  });

  it("is fully interpolated, with no template placeholders left in it", () => {
    expect(STEALTH_INIT).not.toContain("${");
  });

  it("is valid JavaScript", () => {
    expect(() => new Function(STEALTH_INIT)).not.toThrow();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserSession } from "./session.js";

/**
 * Chromium needs both its downloaded binary and a pile of system libraries
 * (libnss3, libgbm, libX11, ...) that a slim container usually lacks and
 * that `playwright install-deps` can only add as root. Rather than fail the
 * whole suite there, probe once and skip — these tests then run wherever a
 * real browser is available and are the only coverage of the actual
 * Playwright wiring.
 */
async function chromiumAvailable(): Promise<boolean> {
  const probeDir = mkdtempSync(path.join(tmpdir(), "searchicus-probe-"));
  const session = new BrowserSession({ profileDir: probeDir });
  try {
    const handle = await session.acquire();
    await handle.release();
    return true;
  } catch {
    return false;
  } finally {
    await session.close();
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const available = await chromiumAvailable();
const profileDirs: string[] = [];

function tempProfile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "searchicus-profile-"));
  profileDirs.push(dir);
  return dir;
}

/** Serves a stable fake origin so tests never touch the network. */
async function serveStubOrigin(page: Page): Promise<void> {
  await page.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>ok</body></html>" }),
  );
}

afterAll(() => {
  for (const dir of profileDirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("BrowserSession (live Chromium)", () => {
  it("does not launch until the first acquire", async () => {
    const session = new BrowserSession({ profileDir: tempProfile() });
    expect(session.launched).toBe(false);

    const handle = await session.acquire();
    expect(session.launched).toBe(true);

    await handle.release();
    await session.close();
  });

  it("hands out a usable page and closes it on release", async () => {
    const session = new BrowserSession({ profileDir: tempProfile() });
    const handle = await session.acquire();

    await serveStubOrigin(handle.lease.page);
    await handle.lease.page.goto("https://example.test/");
    expect(await handle.lease.page.textContent("body")).toBe("ok");

    await handle.release();
    expect(handle.lease.page.isClosed()).toBe(true);

    await session.close();
  });

  it("rejects an additional page request after its signal aborts", async () => {
    const controller = new AbortController();
    const session = new BrowserSession({ profileDir: tempProfile() });
    const handle = await session.acquire(controller.signal);

    controller.abort();

    await expect(handle.lease.newPage()).rejects.toThrow(/abort/i);
    await handle.release();
    await session.close();
  });

  it("shares cookies between pages, which is the point of one context", async () => {
    const session = new BrowserSession({ profileDir: tempProfile() });
    const handle = await session.acquire();

    const first = handle.lease.page;
    await serveStubOrigin(first);
    await first.goto("https://example.test/");
    // String expressions rather than closures: these run in the browser, and
    // core's tsconfig has no DOM lib for `document`/`localStorage` to typecheck against.
    await first.evaluate<void>('document.cookie = "searchicus=shared; path=/"');

    const second = await handle.lease.newPage();
    await serveStubOrigin(second);
    await second.goto("https://example.test/");

    expect(await second.evaluate<string>("document.cookie")).toContain("searchicus=shared");

    await handle.release();
    expect(second.isClosed()).toBe(true);
    await session.close();
  });

  it("carries storage across restarts, which is the point of a persistent profile", async () => {
    const profileDir = tempProfile();

    const first = new BrowserSession({ profileDir });
    const firstHandle = await first.acquire();
    await serveStubOrigin(firstHandle.lease.page);
    await firstHandle.lease.page.goto("https://example.test/");
    await firstHandle.lease.page.evaluate<void>('localStorage.setItem("searchicus", "remembered")');
    await firstHandle.release();
    await first.close();

    const second = new BrowserSession({ profileDir });
    const secondHandle = await second.acquire();
    await serveStubOrigin(secondHandle.lease.page);
    await secondHandle.lease.page.goto("https://example.test/");

    expect(await secondHandle.lease.page.evaluate<string | null>('localStorage.getItem("searchicus")')).toBe(
      "remembered",
    );

    await secondHandle.release();
    await second.close();
  });

  it("queues acquires past the page cap and resumes them on release", async () => {
    const session = new BrowserSession({ profileDir: tempProfile(), maxPages: 1 });
    const first = await session.acquire();

    let secondResolved = false;
    const second = session.acquire().then((handle) => {
      secondResolved = true;
      return handle;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondResolved).toBe(false);

    await first.release();
    await (await second).release();
    expect(secondResolved).toBe(true);

    await session.close();
  });
});

describe("launchOptions as a factory", () => {
  it("is not called until something actually needs a browser", async () => {
    // The laziness the whole design rests on: an engine that never calls
    // acquireBrowser() must cause no browser work, and resolving the options
    // means shelling out to the binary for its version.
    let calls = 0;
    const session = new BrowserSession({
      profileDir: tempProfile(),
      launchOptions: () => {
        calls++;
        return { headless: true };
      },
    });

    expect(calls).toBe(0);

    await session.close();
    expect(calls).toBe(0);
  });

  it.skipIf(!available)("resolves an async factory before launching", async () => {
    let calls = 0;
    const session = new BrowserSession({
      profileDir: tempProfile(),
      launchOptions: async () => {
        calls++;
        return { headless: true, userAgent: "searchicus-factory-probe" };
      },
    });

    const handle = await session.acquire();
    await serveStubOrigin(handle.lease.page);
    await handle.lease.page.goto("https://example.invalid/");

    expect(calls).toBe(1);
    await expect(handle.lease.page.evaluate<string>("navigator.userAgent")).resolves.toBe("searchicus-factory-probe");

    await handle.release();
    await session.close();
  });
});

describe.skipIf(!available)("initScript", () => {
  it("runs in the document before page scripts do", async () => {
    const session = new BrowserSession({
      profileDir: tempProfile(),
      initScript: `window.__searchicusInitRan = true;`,
    });

    const handle = await session.acquire();
    await serveStubOrigin(handle.lease.page);
    await handle.lease.page.goto("https://example.invalid/");

    await expect(handle.lease.page.evaluate<boolean>("window.__searchicusInitRan === true")).resolves.toBe(true);

    await handle.release();
    await session.close();
  });

  it("applies to additional pages opened from the same lease", async () => {
    const session = new BrowserSession({
      profileDir: tempProfile(),
      initScript: `window.__searchicusInitRan = true;`,
    });

    const handle = await session.acquire();
    const extra = await handle.lease.newPage();
    await serveStubOrigin(extra);
    await extra.goto("https://example.invalid/");

    await expect(extra.evaluate<boolean>("window.__searchicusInitRan === true")).resolves.toBe(true);

    await handle.release();
    await session.close();
  });
});

describe.skipIf(available)("BrowserSession (Chromium unavailable)", () => {
  it("reports a diagnosable error rather than a bare launch failure", async () => {
    const session = new BrowserSession({ profileDir: tempProfile() });
    await expect(session.acquire()).rejects.toThrow(/install-deps|Could not launch Chromium/);
    await session.close();
  });
});

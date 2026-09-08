import { lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchPersistentContext } = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launchPersistentContext } }));

import { PROFILE_LOCK_FILENAME, findStaleProfileLock } from "./profile-lock.js";
import { BrowserSession } from "./session.js";

const directories: string[] = [];

function profileWithLock(target = "foreign-host-4321"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "searchicus-profile-lock-"));
  directories.push(directory);
  symlinkSync(target, path.join(directory, PROFILE_LOCK_FILENAME));
  return directory;
}

afterEach(async () => {
  launchPersistentContext.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("profile lock inspection", () => {
  it("recognizes a dangling SingletonLock from another host", () => {
    const profileDir = profileWithLock("foreign-host-4321");

    expect(findStaleProfileLock(profileDir, "this-host")).toEqual({
      path: path.join(profileDir, PROFILE_LOCK_FILENAME),
      ownerHostname: "foreign-host",
      currentHostname: "this-host",
    });
  });

  it("leaves this host's and malformed locks alone", () => {
    expect(findStaleProfileLock(profileWithLock("this-host-4321"), "this-host")).toBeUndefined();
    expect(findStaleProfileLock(profileWithLock("not-a-chromium-lock"), "this-host")).toBeUndefined();
  });
});

describe("BrowserSession stale profile lock recovery", () => {
  it("names a foreign lock and leaves it untouched without operator opt-in", async () => {
    const profileDir = profileWithLock();
    launchPersistentContext.mockRejectedValue(new Error("profile is in use"));
    const session = new BrowserSession({ profileDir });

    await expect(session.acquire()).rejects.toThrow(
      new RegExp(`${PROFILE_LOCK_FILENAME}.*foreign-host.*browser.profileUnlock`),
    );
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(lstatSync(path.join(profileDir, PROFILE_LOCK_FILENAME)).isSymbolicLink()).toBe(true);
    await session.close();
  });

  it("removes only a known foreign lock and retries when explicitly enabled", async () => {
    const profileDir = profileWithLock();
    const page = { close: vi.fn().mockResolvedValue(undefined) };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    launchPersistentContext.mockRejectedValueOnce(new Error("profile is in use")).mockResolvedValueOnce(context);
    const session = new BrowserSession({ profileDir, unlockStaleProfile: true });

    const handle = await session.acquire();

    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(() => lstatSync(path.join(profileDir, PROFILE_LOCK_FILENAME))).toThrow();
    await handle.release();
    await session.close();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

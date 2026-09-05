import { describe, expect, it } from "vitest";
import { LazyLaunch } from "./lazy-launch.js";

/** A resource whose launch this test controls the timing of. */
function controllable() {
  const disposed: string[] = [];
  let release: (value: string) => void = () => undefined;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });

  const lazy = new LazyLaunch<string>(
    () => pending,
    async (resource) => void disposed.push(resource),
  );
  return { lazy, disposed, release };
}

describe("LazyLaunch", () => {
  it("launches once and hands the same resource to concurrent callers", async () => {
    let launches = 0;
    const lazy = new LazyLaunch<string>(
      async () => {
        launches++;
        return "browser";
      },
      async () => undefined,
    );

    expect(lazy.launched).toBe(false);
    expect(await Promise.all([lazy.get(), lazy.get(), lazy.get()])).toEqual(["browser", "browser", "browser"]);
    expect(launches).toBe(1);
    expect(lazy.launched).toBe(true);
  });

  it("disposes a resource whose launch finished after close began", async () => {
    // The regression: close() dropped the reference to an in-flight launch
    // without waiting, so the continuation stored a browser behind an already
    // closed object and left it running.
    const { lazy, disposed, release } = controllable();

    const pending = lazy.get();
    void pending.catch(() => undefined);

    const closing = lazy.close();
    release("late browser");
    await closing;

    expect(disposed).toEqual(["late browser"]);
    expect(lazy.launched).toBe(false);
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("does not resolve close() while a launch is still in flight", async () => {
    const { lazy, disposed, release } = controllable();
    void lazy.get().catch(() => undefined);

    let settled = false;
    const closing = lazy.close().then(() => void (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    release("late browser");
    await closing;
    expect(settled).toBe(true);
    expect(disposed).toEqual(["late browser"]);
  });

  it("disposes a resource that was already up when close was called", async () => {
    const disposed: string[] = [];
    const lazy = new LazyLaunch<string>(
      async () => "browser",
      async (resource) => void disposed.push(resource),
    );

    await lazy.get();
    await lazy.close();
    expect(disposed).toEqual(["browser"]);
    await expect(lazy.get()).rejects.toThrow(/closed/);
  });

  it("relaunches after a resource dies, and ignores a stale death", async () => {
    let launches = 0;
    const lazy = new LazyLaunch<string>(
      async () => `browser-${++launches}`,
      async () => undefined,
    );

    const first = await lazy.get();
    lazy.forget(first);
    const second = await lazy.get();
    expect(second).toBe("browser-2");

    // A crash event for a browser already replaced must not discard its
    // replacement.
    lazy.forget(first);
    expect(lazy.current).toBe("browser-2");
  });

  it("closes cleanly more than once, and when nothing ever launched", async () => {
    const disposed: string[] = [];
    const lazy = new LazyLaunch<string>(
      async () => "browser",
      async (resource) => void disposed.push(resource),
    );

    await lazy.close();
    await lazy.close();
    expect(disposed).toEqual([]);
  });
});

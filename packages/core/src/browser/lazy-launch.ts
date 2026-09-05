/**
 * A resource that is launched on first use and torn down once.
 *
 * Both browsers here are expensive to start, must not start until something
 * actually needs one, and must be replaced if they die. That much was already
 * true in two places. What was also true in two places was a bug: `close()`
 * dropped the reference to an in-flight launch without waiting for it, so a
 * launch that resolved afterwards ran its continuation against a closed
 * object, stored the new browser, and left it running after `close()` had
 * already resolved. On a laptop that is a stray Chromium; in a container it is
 * a process the runtime believes it has already stopped.
 *
 * Two rules close it, and both are needed. The continuation checks whether
 * shutdown began while it was launching and disposes what it just created
 * rather than storing it; and `close()` waits for a launch in flight, so it
 * does not return while a browser is still on its way up. Whichever runs
 * first disposes, and the other finds nothing left to do.
 */
export class LazyLaunch<T> {
  readonly #launch: () => Promise<T>;
  readonly #dispose: (resource: T) => Promise<void>;
  #resource: T | undefined;
  #launching: Promise<T> | undefined;
  #closed = false;

  constructor(launch: () => Promise<T>, dispose: (resource: T) => Promise<void>) {
    this.#launch = launch;
    this.#dispose = dispose;
  }

  /** The live resource, or undefined if nothing has been launched. */
  get current(): T | undefined {
    return this.#resource;
  }

  /** True once something has actually been launched and is still held. */
  get launched(): boolean {
    return this.#resource !== undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Launches on first use and memoizes. Concurrent callers share one launch. */
  async get(): Promise<T> {
    if (this.#closed) throw new Error("Resource is closed");
    if (this.#resource) return this.#resource;
    if (this.#launching) return this.#launching;

    this.#launching = (async () => {
      const resource = await this.#launch();

      // Shutdown began while this was starting. Storing it now would leave a
      // browser running behind a closed object, which is the whole bug.
      if (this.#closed) {
        await this.#dispose(resource).catch(() => undefined);
        throw new Error("Resource is closed");
      }

      this.#resource = resource;
      return resource;
    })();

    try {
      return await this.#launching;
    } finally {
      this.#launching = undefined;
    }
  }

  /**
   * Drops a resource that died on its own, so the next `get()` relaunches.
   *
   * Takes the resource rather than clearing unconditionally: a crash event
   * for a browser that has already been replaced must not discard its
   * replacement.
   */
  forget(resource: T): void {
    if (this.#resource === resource) this.#resource = undefined;
  }

  /** Closes for good. Safe to call more than once, and while a launch is in flight. */
  async close(): Promise<void> {
    this.#closed = true;

    // Waiting here is the point: returning while a launch is still in flight
    // would let its continuation outlive this call. It rejects on the branch
    // above, having already disposed what it made.
    if (this.#launching) await this.#launching.catch(() => undefined);

    const resource = this.#resource;
    this.#resource = undefined;
    this.#launching = undefined;
    if (resource) await this.#dispose(resource).catch(() => undefined);
  }
}

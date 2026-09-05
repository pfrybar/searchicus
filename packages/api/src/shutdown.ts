import type { Server } from "node:http";

/** How long to wait for browser sessions and queued archive writes before exiting. */
const SHUTDOWN_GRACE_MS = 15_000;

interface Closeable {
  close(): Promise<void>;
}

/**
 * Stops accepting connections, then lets in-flight browser sessions and
 * queued archive writes finish before exiting. Searches can return results
 * while either is still running, so exiting when the HTTP server closes would
 * kill best-effort work — but a wedged task must not block shutdown forever,
 * hence the grace period.
 */
export function shutdownOn(server: Server, registry: Closeable): void {
  let shuttingDown = false;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}, finishing in-flight search work...`);

      const forceExit = setTimeout(() => {
        console.warn("Shutdown grace period elapsed; exiting with search work still running.");
        process.exit(1);
      }, SHUTDOWN_GRACE_MS);
      forceExit.unref();

      // close() waits for every open connection, and a browser holding an
      // idle keep-alive socket would otherwise spend the whole grace period
      // before the drain below even starts.
      server.closeIdleConnections();
      server.close(() => {
        void registry
          .close()
          .catch((err: unknown) => console.error("Error during shutdown:", err))
          .finally(() => {
            clearTimeout(forceExit);
            process.exit(0);
          });
      });
    });
  }
}

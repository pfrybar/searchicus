import type { Server } from "node:http";

/** How long to wait for live browser sessions before exiting anyway. */
const SHUTDOWN_GRACE_MS = 15_000;

interface Closeable {
  close(): Promise<void>;
}

/**
 * Stops accepting connections, then lets in-flight browser sessions finish
 * before exiting. Searches can return results while their browser work is
 * still running, so exiting the moment the HTTP server closes would kill
 * that work — but a wedged session must not block shutdown forever either,
 * hence the grace period.
 */
export function shutdownOn(server: Server, registry: Closeable): void {
  let shuttingDown = false;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}, finishing in-flight sessions...`);

      const forceExit = setTimeout(() => {
        console.warn("Shutdown grace period elapsed; exiting with sessions still running.");
        process.exit(1);
      }, SHUTDOWN_GRACE_MS);
      forceExit.unref();

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

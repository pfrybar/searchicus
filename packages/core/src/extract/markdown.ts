import { Worker } from "node:worker_threads";
import { ExtractFailedError } from "./errors.js";
import type { DocumentParser, ParsedDocument } from "./types.js";

/**
 * Heap ceiling for one parse. Defuddle walks and rewrites the whole DOM, and
 * a deliberately pathological document — millions of nodes, catastrophic
 * nesting — can consume memory without bound. Inside a worker that ends as a
 * dead worker; on the main thread it ends as a dead API process.
 */
export const PARSE_MAX_HEAP_MB = 512;

/**
 * How much worker diagnostic output to keep for a failed parse.
 *
 * Bounded because the text is influenced by the page: a document can provoke
 * parser warnings that quote its own content, and an unbounded buffer would
 * let it decide how much memory this holds.
 */
export const MAX_PARSE_DIAGNOSTIC_CHARS = 4_000;

/**
 * The parse, as it runs inside the worker.
 *
 * A string, for the same reason `STEALTH_INIT` is one: this code executes in
 * a realm the type checker cannot follow. It is loaded through a `data:` URL
 * so there is no build artifact to ship or resolve — which would otherwise
 * mean one path from `src/` under vitest and another from `dist/` at runtime.
 * A `data:` module cannot resolve bare specifiers, so the parent resolves
 * them and passes the absolute URLs in.
 *
 * `useAsync: false` is load-bearing rather than a performance choice: with it
 * unset, Defuddle's fallback extractors may call third-party APIs, which
 * would open a network path around the entire extraction policy.
 */
const PARSE_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";

const { parseHTML } = await import(workerData.linkedom);
const { Defuddle } = await import(workerData.defuddle);

const { document } = parseHTML(workerData.html);

// Defuddle expects a few DOM APIs linkedom does not provide. Its own node
// entry applies these when handed an HTML string, but that path is marked
// deprecated and the helper is not exported, so they are applied here.
if (!document.styleSheets) document.styleSheets = [];
if (document.defaultView && !document.defaultView.getComputedStyle) {
  document.defaultView.getComputedStyle = () => ({ display: "" });
}
document.URL = workerData.url;

// The one that matters. Defuddle's metadata reads doc.location.href before
// anything else, and linkedom has no location at all -- so it fell through to
// the page's own og:url, twitter:url, schema.org url or canonical. Two
// consequences, both bad: a relative canonical (href="/story", which is
// everywhere) made it throw and log a warning on every such extraction, and a
// page supplying an absolute one decided what Defuddle believed its domain to
// be, a value that feeds Defuddle's own title cleaning. Handing it the URL we
// actually fetched settles both.
document.location = { href: workerData.url };

const result = await Defuddle(document, workerData.url, {
  markdown: true,
  useAsync: false,
  removeImages: true,
});

// Only these fields cross back. Defuddle also returns favicon and image URLs,
// raw meta-tag maps, schema.org blobs, debug data, and the original HTML,
// none of which belong in a response or an archive row.
parentPort.postMessage({
  title: typeof result.title === "string" ? result.title : "",
  markdown: typeof result.content === "string" ? result.content : "",
  wordCount: typeof result.wordCount === "number" ? result.wordCount : 0,
  language: result.language || undefined,
  author: result.author || undefined,
  published: result.published || undefined,
});
`;

/**
 * Builds a parser that runs Defuddle in a fresh, memory-capped worker.
 *
 * One worker per extraction rather than a reused pool: extractions are few
 * (MAX_CONCURRENT defaults to 2) so the ~40ms start is noise against a
 * multi-second render, and a fresh realm means one hostile document cannot
 * leave anything behind for the next.
 */
export function createWorkerParser(): DocumentParser {
  const linkedom = import.meta.resolve("linkedom");
  const defuddle = import.meta.resolve("defuddle/node");

  return (html, url, signal) =>
    new Promise<ParsedDocument>((resolve, reject) => {
      if (signal.aborted) {
        reject(new ExtractFailedError("cancelled", "Extraction was cancelled."));
        return;
      }

      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(PARSE_WORKER_SOURCE)}`), {
        workerData: { html, url, linkedom, defuddle },
        resourceLimits: { maxOldGenerationSizeMb: PARSE_MAX_HEAP_MB },
        // The page's own content decides nothing about this process.
        env: {},
        argv: [],
        stdin: false,
        // Captured rather than inherited. Left to default, anything the parser
        // prints while chewing on an arbitrary page lands in the server's log
        // -- noise at best, and at worst a page choosing what gets written
        // there. Kept for a failure, dropped for a success.
        stdout: true,
        stderr: true,
      });

      let diagnostics = "";
      worker.stderr.on("data", (chunk: Buffer) => {
        if (diagnostics.length < MAX_PARSE_DIAGNOSTIC_CHARS) diagnostics += String(chunk);
      });
      // Drained, not read: an unconsumed stream applies back-pressure to a
      // worker that is only trying to print.
      worker.stdout.resume();

      /** What the worker printed, for a log and never for a response. */
      const withDiagnostics = (err: unknown): unknown => {
        if (diagnostics && err instanceof Error) err.cause = diagnostics.slice(0, MAX_PARSE_DIAGNOSTIC_CHARS);
        return err;
      };

      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        void worker.terminate();
        outcome();
      };

      function onAbort(): void {
        finish(() => reject(new ExtractFailedError("cancelled", "Extraction was cancelled.")));
      }

      signal.addEventListener("abort", onAbort, { once: true });

      worker.on("message", (parsed: ParsedDocument) => finish(() => resolve(parsed)));
      worker.on("error", (err) => {
        finish(() =>
          reject(new ExtractFailedError("parse_failed", "That page could not be read.", withDiagnostics(err))),
        );
      });
      worker.on("exit", (code) => {
        // Reached only when the worker died without posting a result — an
        // out-of-memory kill against the heap cap above looks like this.
        finish(() =>
          reject(
            new ExtractFailedError(
              "parse_failed",
              "That page could not be read.",
              withDiagnostics(new Error(`worker exited with code ${code}`)),
            ),
          ),
        );
      });
    });
}

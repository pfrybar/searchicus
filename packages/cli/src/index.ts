#!/usr/bin/env node
import {
  createDefaultRegistry,
  defaultDataDir,
  defaultProfileDir,
  defaultStorePath,
  ExtractionService,
  ExtractRequestSchema,
  MAX_SEARCH_LIMIT,
  OutlineRequestSchema,
  SearchEngineRegistry,
  SearchRequestSchema,
} from "@searchicus/core";
import { Command, InvalidArgumentError } from "commander";
import { pathToFileURL } from "node:url";
import { formatExtract, formatOutline, formatSearch } from "./format.js";

/** Parse and validate the CLI's final merged-result limit with the shared rules. */
export function parseLimit(value: string): number {
  const parsed = SearchRequestSchema.shape.limit.safeParse(Number(value));
  if (!parsed.success || parsed.data === undefined) {
    throw new InvalidArgumentError(
      !parsed.success
        ? (parsed.error.issues[0]?.message ?? `limit must be a number from 1 to ${MAX_SEARCH_LIMIT}`)
        : "limit is required",
    );
  }

  return parsed.data;
}

/** Parse and validate a read offset with the shared rules. */
export function parseOffset(value: string): number {
  const parsed = ExtractRequestSchema.shape.offset.safeParse(Number(value));
  if (!parsed.success || parsed.data === undefined) {
    throw new InvalidArgumentError(parsed.success ? "offset is required" : "offset must be a whole number, 0 or more");
  }

  return parsed.data;
}

/** Parse and validate the CLI's Markdown budget with the shared rules. */
export function parseMaxChars(value: string): number {
  const parsed = ExtractRequestSchema.shape.maxChars.safeParse(Number(value));
  if (!parsed.success || parsed.data === undefined) {
    throw new InvalidArgumentError(
      !parsed.success
        ? (parsed.error.issues[0]?.message ?? "max-chars must be a number from 1 to 100000")
        : "max-chars is required",
    );
  }

  return parsed.data;
}

/**
 * Creates the CLI program. Supplying a registry makes command behavior easy
 * to exercise in tests without relying on module-level state. Its default is
 * core's browser-free registry, which can list registered engines but cannot
 * run browser-backed ones; executable CLI usage injects createBrowserRegistry().
 */
export function createProgram(
  registry: SearchEngineRegistry = createDefaultRegistry(),
  extraction: ExtractionService = new ExtractionService(),
): Command {
  const program = new Command();

  program.name("searchicus").description("Send a search query to one or more backend search engines.").version("0.1.0");

  program
    .command("search <query>")
    .description("Search for a query across one or more engines")
    .option("-e, --engine <id...>", "engine id(s) to search; defaults to every registered engine")
    .option("-l, --limit <n>", `max merged results (1–${MAX_SEARCH_LIMIT}; defaults to 8)`, parseLimit)
    .option("--json", "print raw JSON instead of a formatted list")
    .action(async (query: string, opts: { engine?: string[]; limit?: number; json?: boolean }) => {
      const parsed = SearchRequestSchema.safeParse({ query, limit: opts.limit, engines: opts.engine });
      if (!parsed.success) {
        throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "Invalid search request");
      }

      const response = await registry.search(parsed.data);

      if (opts.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      console.log(formatSearch(response).join("\n"));
    });

  program
    .command("extract <url>")
    .description("Render a page and print its main content as Markdown")
    .option("-m, --max-chars <n>", "max characters of Markdown (1\u2013100000; defaults to 20000)", parseMaxChars)
    .option("-o, --offset <n>", "start reading here; use the nextOffset a previous run printed", parseOffset)
    .option("--json", "print raw JSON instead of formatted Markdown")
    .action(async (url: string, opts: { maxChars?: number; offset?: number; json?: boolean }) => {
      const parsed = ExtractRequestSchema.safeParse({ url, maxChars: opts.maxChars, offset: opts.offset });
      if (!parsed.success) {
        throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "Invalid extract request");
      }

      const response = await extraction.extract(parsed.data);

      if (opts.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      console.log(formatExtract(response).join("\n"));
    });

  program
    .command("outline <url>")
    .description("List a page's sections and the offsets to read them")
    .option("--json", "print raw JSON instead of a table of contents")
    .action(async (url: string, opts: { json?: boolean }) => {
      const parsed = OutlineRequestSchema.safeParse({ url });
      if (!parsed.success) {
        throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "Invalid outline request");
      }

      const page = await extraction.outline(parsed.data);

      if (opts.json) {
        console.log(JSON.stringify(page, null, 2));
        return;
      }

      console.log(formatOutline(page).join("\n"));
    });

  program
    .command("paths")
    .description("Show where this machine keeps its profiles and search archive")
    .option("--json", "print raw JSON instead of a formatted list")
    .action((opts: { json?: boolean }) => {
      // Worth a command of its own: these resolve from the application root
      // and the environment, so "which archive am I looking at" is otherwise
      // a question you can only answer by guessing.
      const paths = {
        dataDir: defaultDataDir(),
        archive: defaultStorePath(),
        profile: defaultProfileDir("cli"),
      };

      if (opts.json) {
        console.log(JSON.stringify(paths, null, 2));
        return;
      }

      for (const [name, value] of Object.entries(paths)) console.log(`${name}\t${value}`);
    });

  program
    .command("engines")
    .description("List registered search engines")
    .option("--json", "print raw JSON instead of a formatted list")
    .action((opts: { json?: boolean }) => {
      const engines = registry.list().map((engine) => ({ id: engine.id, name: engine.name }));

      if (opts.json) {
        console.log(JSON.stringify(engines, null, 2));
        return;
      }

      for (const engine of engines) {
        console.log(`${engine.id}\t${engine.name}`);
      }
    });

  return program;
}

/**
 * Hides the "SQLite is an experimental feature" warning Node 22 emits the
 * first time the archive opens — which is just after a search has printed its
 * results, so it lands in the middle of the output a user is reading. Only
 * that one warning is dropped, and only for the CLI: the API server keeps
 * every warning, where a line on startup is a log entry rather than noise.
 */
function silenceSqliteExperimentalWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && warning.message.startsWith("SQLite")) return;
    for (const listener of listeners) listener(warning);
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  silenceSqliteExperimentalWarning();

  // Imported dynamically so that merely importing createProgram() — as the
  // tests do — never pulls Playwright into the module graph.
  const { createDefaultSearchArchive } = await import("@searchicus/core");
  const { createBrowserExtraction, createBrowserRegistry } = await import("@searchicus/core/browser");
  // One archive for both, and deliberately not one browser: see
  // createBrowserExtraction.
  const archive = createDefaultSearchArchive();
  const registry = createBrowserRegistry("cli", { archive });
  const extraction = createBrowserExtraction({ archive });

  try {
    await createProgram(registry, extraction).parseAsync(process.argv);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // A search can return results while its browser session is still
    // running. Exiting here without draining would kill that work mid-flight.
    await extraction.close();
    await registry.close();
  }
}

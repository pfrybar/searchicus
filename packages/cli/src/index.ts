#!/usr/bin/env node
import { createDefaultRegistry, SearchEngineRegistry, SearchRequestSchema } from "@searchicus/core";
import { Command, InvalidArgumentError } from "commander";
import { pathToFileURL } from "node:url";
import { formatOutcome } from "./format.js";

/**
 * Creates the CLI program. Supplying a registry makes command behavior easy
 * to exercise in tests without relying on module-level state. Its default is
 * core's browser-free registry, which can list registered engines but cannot
 * run browser-backed ones; executable CLI usage injects createBrowserRegistry().
 */
export function createProgram(registry: SearchEngineRegistry = createDefaultRegistry()): Command {
  const program = new Command();

  program.name("searchicus").description("Send a search query to one or more backend search engines.").version("0.1.0");

  program
    .command("search <query>")
    .description("Search for a query across one or more engines")
    .option("-e, --engine <id...>", "engine id(s) to search; defaults to every registered engine")
    .option("--json", "print raw JSON instead of a formatted list")
    .action(async (query: string, opts: { engine?: string[]; json?: boolean }) => {
      const parsed = SearchRequestSchema.safeParse({ query, engines: opts.engine });
      if (!parsed.success) {
        throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "Invalid search request");
      }

      const { engines: engineIds, ...searchQuery } = parsed.data;
      const outcomes = await registry.searchAll(searchQuery, engineIds);

      if (opts.json) {
        console.log(JSON.stringify(outcomes, null, 2));
        return;
      }

      for (const outcome of outcomes) {
        console.log(formatOutcome(outcome).join("\n"));
      }
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

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  // Imported dynamically so that merely importing createProgram() — as the
  // tests do — never pulls Playwright into the module graph.
  const { createBrowserRegistry } = await import("@searchicus/core/browser");
  const registry = createBrowserRegistry("cli");

  try {
    await createProgram(registry).parseAsync(process.argv);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // A search can return results while its browser session is still
    // running. Exiting here without draining would kill that work mid-flight.
    await registry.close();
  }
}

#!/usr/bin/env node
import { MockSearchEngine, SearchEngineRegistry, SearchQuerySchema } from "@searchicus/core";
import { Command, InvalidArgumentError } from "commander";
import { pathToFileURL } from "node:url";
import { formatOutcome } from "./format.js";

/**
 * Builds the registry the CLI searches against. Real backends aren't wired
 * up yet (see AGENTS.md) — this is the one place that would change to
 * register them.
 */
export function createRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry().register(new MockSearchEngine());
}

/** Parse and validate the CLI's numeric limit with the core's shared rules. */
export function parseLimit(value: string): number {
  const parsed = SearchQuerySchema.shape.limit.safeParse(Number(value));
  if (!parsed.success || parsed.data === undefined) {
    throw new InvalidArgumentError(
      !parsed.success
        ? (parsed.error.issues[0]?.message ?? "limit must be a number from 1 to 100")
        : "limit is required",
    );
  }

  return parsed.data;
}

/**
 * Creates the CLI program. Supplying a registry makes command behavior easy
 * to exercise in tests without relying on module-level state.
 */
export function createProgram(registry: SearchEngineRegistry = createRegistry()): Command {
  const program = new Command();

  program.name("searchicus").description("Send a search query to one or more backend search engines.").version("0.1.0");

  program
    .command("search <query>")
    .description("Search for a query across one or more engines")
    .option("-e, --engine <id...>", "engine id(s) to search; defaults to every registered engine")
    .option("-l, --limit <n>", "max results per engine (1–100)", parseLimit, 10)
    .option("--json", "print raw JSON instead of a formatted list")
    .action(async (query: string, opts: { engine?: string[]; limit: number; json?: boolean }) => {
      const parsed = SearchQuerySchema.safeParse({ query, limit: opts.limit });
      if (!parsed.success) {
        throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "Invalid search query");
      }

      const engineIds = opts.engine ?? registry.list().map((engine) => engine.id);
      const outcomes = await registry.searchAll(parsed.data, engineIds);

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
  createProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}

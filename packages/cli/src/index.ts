#!/usr/bin/env node
import { MockSearchEngine, SearchEngineRegistry } from "@searchicus/core";
import { Command } from "commander";
import { formatOutcome } from "./format.js";

/**
 * Builds the registry the CLI searches against. Real backends aren't wired
 * up yet (see AGENTS.md) — this is the one place that would change to
 * register them.
 */
function createRegistry(): SearchEngineRegistry {
  return new SearchEngineRegistry().register(new MockSearchEngine());
}

const program = new Command();

program.name("searchicus").description("Send a search query to one or more backend search engines.").version("0.1.0");

program
  .command("search <query>")
  .description("Search for a query across one or more engines")
  .option("-e, --engine <id...>", "engine id(s) to search; defaults to every registered engine")
  .option("-l, --limit <n>", "max results per engine", (value) => Number.parseInt(value, 10), 10)
  .option("--json", "print raw JSON instead of a formatted list")
  .action(async (query: string, opts: { engine?: string[]; limit: number; json?: boolean }) => {
    const registry = createRegistry();
    const engineIds = opts.engine ?? registry.list().map((engine) => engine.id);
    const outcomes = await registry.searchAll({ query, limit: opts.limit }, engineIds);

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
    const engines = createRegistry()
      .list()
      .map((engine) => ({ id: engine.id, name: engine.name }));

    if (opts.json) {
      console.log(JSON.stringify(engines, null, 2));
      return;
    }

    for (const engine of engines) {
      console.log(`${engine.id}\t${engine.name}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

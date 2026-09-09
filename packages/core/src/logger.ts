/**
 * Logging for the server surfaces.
 *
 * Every handled failure — an engine giving up, an archive write failing, a
 * page refused by the address policy, a parse worker's own diagnostics — is
 * swallowed so that it cannot affect the response, and written here so that
 * it is not also lost. Those are two requirements, and only the first of
 * them is served by saying nothing. The archive is a record of what was
 * searched, not of what went wrong.
 *
 * Three rules shape this:
 *
 * - **stderr, always.** The CLI prints results to stdout and people pipe it
 *   into `jq`. A log line on stdout would corrupt that.
 * - **Silent under test.** Suites that deliberately exercise failure paths
 *   should not print walls of expected warnings.
 * - **No query text above debug.** Queries are the sensitive part of this
 *   system — the README says so about the archive — and logs are copied,
 *   shipped and read far more casually than a database file.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** How much to say. The `log` slice of the configuration tree. */
export interface LogConfig {
  readonly level: LogLevel;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Structured detail for a line. Rendered as `key=value` after the message. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Where lines go. Replaceable so a host can ship them somewhere else. */
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => process.stderr.write(`${line}\n`);
let level: LogLevel = defaultLevel();

function defaultLevel(): LogLevel {
  const configured = process.env.SEARCHICUS_LOG_LEVEL?.trim().toLowerCase();
  if (configured && configured in RANK) return configured as LogLevel;
  // Vitest sets this. Suites here exercise failure paths on purpose, and a
  // passing run should not be a wall of expected warnings.
  if (process.env.VITEST) return "silent";
  return "info";
}

export function setLogLevel(next: LogLevel): void {
  level = next;
}

export function getLogLevel(): LogLevel {
  return level;
}

export function setLogSink(next: LogSink): void {
  sink = next;
}

/**
 * True when a level of `threshold` would write a line at `at`.
 *
 * Split out for the one caller that holds a level it has read but not yet
 * applied: `loadConfig()` warns while finalizing, before any front door has
 * called `setLogLevel()`, and the ordering of levels should be written down
 * once.
 */
export function levelAllows(threshold: LogLevel, at: LogLevel): boolean {
  return RANK[at] >= RANK[threshold] && threshold !== "silent";
}

/** True when a line at this level would actually be written. */
export function logEnabled(at: LogLevel): boolean {
  return levelAllows(level, at);
}

/**
 * Renders one field value.
 *
 * Errors become their message rather than "[object Object]", and anything
 * with whitespace is quoted so `key=value` stays parseable by eye and by
 * `awk`. Multi-line values (a stack, a parser's own output) are flattened,
 * because a log line that spans lines is a log line that cannot be grepped.
 */
function render(value: unknown): string {
  if (value === undefined) return "-";
  if (value === null) return "null";

  const text =
    value instanceof Error ? value.message : typeof value === "object" ? JSON.stringify(value) : String(value);

  const flat = text.replace(/\s+/g, " ").trim();
  return /[\s"]/.test(flat) ? JSON.stringify(flat.slice(0, 300)) : flat;
}

function write(at: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (!logEnabled(at)) return;

  const parts = [new Date().toISOString(), at.toUpperCase().padEnd(5), scope.padEnd(9), message];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) parts.push(`${key}=${render(value)}`);
  }
  sink(parts.join(" "));
}

/** A logger tagged with the subsystem it speaks for. */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => write("debug", scope, message, fields),
    info: (message, fields) => write("info", scope, message, fields),
    warn: (message, fields) => write("warn", scope, message, fields),
    error: (message, fields) => write("error", scope, message, fields),
  };
}

/** Unwraps an error's chain into something a single line can carry. */
export function causeOf(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  const chain: string[] = [];

  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 4) {
    seen.add(current);
    chain.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain.length > 0 ? chain.join(" <- ") : undefined;
}

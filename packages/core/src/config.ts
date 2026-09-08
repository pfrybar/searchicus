/**
 * One configuration tree for every surface.
 *
 * Three sources, in order: the defaults below, a YAML file, then the
 * environment. Each layer overrides the one before it key by key, so an
 * operator can set two values in a file and one more at run time without
 * restating anything else.
 *
 * Two rules shape this:
 *
 * - **Operator values only.** Paths, ports, timeouts, limits, concurrency,
 *   enablement and the rate policy live here. Tuned algorithm constants
 *   (BM25 weights, the relevance threshold, the browser's window
 *   fingerprint) stay in the module that owns them: they are set against a
 *   measured failure, and an operator changing one gets a worse result with
 *   no error. So do the caller-facing bounds wired into the request schemas
 *   and the MCP tool descriptions, because a caller was told what they are.
 * - **Invalid means stop.** A misconfiguration is found once, at startup,
 *   before anything is served. The alternative — falling back to the default
 *   and carrying on — is how `maxBytes: 5MB` silently becomes five mebibytes
 *   and an afternoon disappears looking for the limit that never applied.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

import type { ExtractConfig } from "./extract/config.js";
import { createLogger } from "./logger.js";
import type { LogConfig } from "./logger.js";
import { applicationRoot } from "./paths.js";
import type { PathsConfig } from "./paths.js";
import type { ArchiveConfig } from "./storage.js";
import type { DashboardConfig } from "./insights.js";
import type { SearchConfig } from "./registry.js";

const log = createLogger("config");

/** Looked for beside the application root when no file is named. */
export const DEFAULT_CONFIG_FILENAME = "config.yaml";
/** Names an explicit config file, overriding discovery. */
export const CONFIG_PATH_ENV = "SEARCHICUS_CONFIG";
/** Prefix shared by every environment override. */
export const ENV_PREFIX = "SEARCHICUS";

/**
 * The vocabulary for boolean values, shared by the file and the environment.
 *
 * Reading the same word two ways in one program is its own bug: `STORE=0`
 * once left archiving on, because that switch understood only the literal
 * string "false" while `MCP_ENABLED=0` beside it meant off. One list, and
 * anything outside it is an error rather than a silent no.
 */
const AFFIRMATIVE = new Set(["true", "1", "yes", "on"]);
const NEGATIVE = new Set(["false", "0", "no", "off"]);

const BOOLEAN_MESSAGE = `expected one of ${[...AFFIRMATIVE, ...NEGATIVE].join(", ")}`;

/**
 * Coercions applied before validation.
 *
 * YAML gives typed scalars; the environment gives only strings. Normalizing
 * here rather than in a separate env parser means one schema validates both,
 * and a bad value produces the same message wherever it came from.
 */
function coerceBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (AFFIRMATIVE.has(normalized)) return true;
  if (NEGATIVE.has(normalized)) return false;
  // Left as-is so z.boolean() reports it, rather than guessing a direction.
  return value;
}

function coerceNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

/** A port list is a YAML sequence or, from the environment, "80,443". */
function coercePortList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.split(",").map((entry) => coerceNumber(entry));
}

/** An empty environment value clears an optional path rather than setting "". */
function coerceOptional(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

const boolean = () => z.preprocess(coerceBoolean, z.boolean({ error: BOOLEAN_MESSAGE }));
const positiveInt = () => z.preprocess(coerceNumber, z.number().int().positive());
const nonNegativeInt = () => z.preprocess(coerceNumber, z.number().int().min(0));
const fraction = () => z.preprocess(coerceNumber, z.number().min(0).max(1));
const nonEmptyString = () => z.string().trim().min(1);

/**
 * A byte size as express reads it: "64kb", "1.5mb", or a plain byte count.
 *
 * Checked here rather than left to `express.json()`, which would otherwise
 * throw `option limit "not-a-size" is invalid` from inside the app factory —
 * after the configuration has been reported as valid, and past the point
 * where anything can say which setting or which layer produced it.
 *
 * A plain count is a size, so YAML's `65536` is read as one rather than
 * refused for being a number: an operator who writes the documented form
 * without quotes meant the documented thing. A bare fraction is not a size,
 * though — 1.5 bytes rounds to one — so `1.5` is an error that asks for the
 * unit the writer plainly had in mind.
 */
const BYTE_SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?$/i;

function coerceByteSize(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

const byteSize = () =>
  z.preprocess(
    coerceByteSize,
    z
      .string()
      .trim()
      .refine(
        (value) => {
          const match = BYTE_SIZE.exec(value);
          if (match === null) return false;
          const size = Number(match[1]);
          // Zero is a valid size and a useless limit: it refuses every body.
          return match[2] === undefined ? Number.isInteger(size) && size >= 1 : size > 0;
        },
        { error: 'expected a byte size such as "64kb", "1.5mb" or "65536"' },
      ),
  );
const optionalPath = () => z.preprocess(coerceOptional, z.string().trim().min(1).nullable());

/**
 * The tree. Every object is strict, so a misspelled key is an error and not
 * a setting that silently does nothing.
 */
export const SearchicusConfigSchema = z.strictObject({
  paths: z.strictObject({
    /** Root for all persistent state. Relative values resolve against the application root, never the working directory. */
    dataDir: nonEmptyString(),
    /** Chromium user-data directory. Null derives one per surface below dataDir. */
    profileDir: optionalPath(),
    /** Archive database file. Null derives one beside the profiles. */
    storePath: optionalPath(),
  }),
  server: z.strictObject({
    /** Bind address. Loopback by default: this server has no authentication. */
    host: nonEmptyString(),
    port: z.preprocess(coerceNumber, z.number().int().min(1).max(65_535)),
    /** Serve the MCP endpoint at /mcp from this process. */
    mcp: boolean(),
    /** Serve the built web UI, when a build is present. */
    ui: boolean(),
    /** Where the UI build is read from. Null uses the packaged location. */
    uiDir: optionalPath(),
    /** Largest request body the API will accept, as an express byte string. */
    jsonBodyLimit: byteSize(),
  }),
  log: z.strictObject({
    level: z.enum(["debug", "info", "warn", "error", "silent"]),
  }),
  archive: z.strictObject({
    /** Record completed fan-outs and reads. Best-effort either way. */
    enabled: boolean(),
    /** How long to wait for another process holding the database lock. */
    busyTimeoutMs: positiveInt(),
  }),
  search: z.strictObject({
    /** Deadline for a fan-out to produce results. */
    resultsTimeoutMs: positiveInt(),
    /** Hard cap on browser work that outlives the results it produced. */
    sessionTimeoutMs: positiveInt(),
    /** Budget kept back for the search itself; below it a caller is refused rather than queued. */
    reserveMs: positiveInt(),
    throttle: z.strictObject({
      /** Minimum spacing between the starts of consecutive fan-outs. */
      minIntervalMs: positiveInt(),
      /** Spread applied to the interval, as a fraction of it. 0 disables. */
      jitter: fraction(),
      /** Callers that may wait at once before further ones are refused. */
      maxQueued: positiveInt(),
    }),
  }),
  browser: z.strictObject({
    /** Ceiling on simultaneously open pages. A memory valve, not the rate policy. */
    maxPages: positiveInt(),
    /** Must stay plausible for the country the traffic leaves from. */
    locale: nonEmptyString(),
    /** Must agree with the geolocation of the egress IP. */
    timezone: nonEmptyString(),
    /** Remove a stale foreign-host Chromium SingletonLock and retry once. */
    profileUnlock: boolean(),
  }),
  extract: z.strictObject({
    /** Renders caller-supplied URLs. Off until an operator turns it on. */
    enabled: boolean(),
    /** Extraction contexts open at once, across the whole process. */
    maxConcurrent: positiveInt(),
    /** Callers that may wait for one of those. */
    maxQueued: positiveInt(),
    /** Deadline for reaching domcontentloaded. */
    navigationTimeoutMs: positiveInt(),
    /** Fixed pause after the DOM is ready, before it is captured. */
    settleTimeoutMs: nonNegativeInt(),
    /** End-to-end budget: render, dwell, parse and respond. */
    timeoutMs: positiveInt(),
    /** A short human-shaped pause that also triggers lazy-loaded content. */
    dwell: boolean(),
    /** Transfer tripwire across the whole render. Degrades it; never fails it. */
    maxBytes: positiveInt(),
    /** Main-document cap. Fails the read with too_large. Clamped to maxBytes. */
    maxDocumentBytes: positiveInt(),
    maxRedirects: nonNegativeInt(),
    /** Destination ports the renderer may open. */
    allowedPorts: z.preprocess(coercePortList, z.array(z.number().int().min(1).max(65_535)).min(1)),
    cache: z.strictObject({
      /** Share one render between outline, find and extract. */
      enabled: boolean(),
      ttlMs: positiveInt(),
      maxEntries: positiveInt(),
      /** Ceiling on Markdown held at once. A cache without one is a leak. */
      maxChars: positiveInt(),
    }),
  }),
  dashboard: z.strictObject({
    /** Recent searches averaged over for engine metrics. */
    metricsWindow: positiveInt(),
    /** Searches listed per page of the browser. */
    searchPageSize: positiveInt(),
    /** Ceiling on both, so a caller cannot ask the process to read everything. */
    maxLimit: positiveInt(),
  }),
});

/** What the file and environment may say, before coercion. */
type ConfigInput = z.input<typeof SearchicusConfigSchema>;
/** What validation produces: typed, but not yet derived. */
type ParsedConfig = z.output<typeof SearchicusConfigSchema>;

/**
 * The defaults, and the single source of truth for what keys exist.
 *
 * Written as plain data rather than as schema-level defaults so it can be
 * walked: the environment variable names are derived from these paths, which
 * is what keeps the two from drifting.
 */
export const DEFAULT_CONFIG_INPUT = {
  paths: { dataDir: ".searchicus", profileDir: null, storePath: null },
  server: { host: "127.0.0.1", port: 3000, mcp: true, ui: true, uiDir: null, jsonBodyLimit: "64kb" },
  log: { level: "info" },
  archive: { enabled: true, busyTimeoutMs: 5_000 },
  search: {
    resultsTimeoutMs: 30_000,
    sessionTimeoutMs: 60_000,
    reserveMs: 12_000,
    throttle: { minIntervalMs: 5_000, jitter: 0.3, maxQueued: 60 },
  },
  browser: { maxPages: 24, locale: "en-US", timezone: "America/Chicago", profileUnlock: false },
  extract: {
    enabled: false,
    maxConcurrent: 2,
    maxQueued: 32,
    navigationTimeoutMs: 10_000,
    settleTimeoutMs: 2_000,
    timeoutMs: 30_000,
    dwell: true,
    maxBytes: 5_242_880,
    maxDocumentBytes: 2_097_152,
    maxRedirects: 5,
    allowedPorts: [80, 443],
    cache: { enabled: true, ttlMs: 300_000, maxEntries: 32, maxChars: 8_000_000 },
  },
  dashboard: { metricsWindow: 500, searchPageSize: 50, maxLimit: 2_000 },
} satisfies ConfigInput;

/**
 * The configuration the application runs on.
 *
 * Written by hand rather than inferred, so the derivations below have to
 * type-check against it: `extract` is the existing ExtractConfig, ports and
 * all, which is what lets the extraction stack keep its own shape.
 */
export interface SearchicusConfig {
  readonly paths: PathsConfig;
  /**
   * Declared here rather than by an owning module, unlike every other slice.
   * The server lives in `packages/api`, which this package cannot import, and
   * the browser layer is behind `@searchicus/core/browser`, which the
   * browser-free main entry must not reach.
   */
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly mcp: boolean;
    readonly ui: boolean;
    readonly uiDir: string | null;
    readonly jsonBodyLimit: string;
  };
  readonly log: LogConfig;
  readonly archive: ArchiveConfig;
  readonly search: SearchConfig;
  readonly browser: {
    readonly maxPages: number;
    readonly locale: string;
    readonly timezone: string;
    readonly profileUnlock: boolean;
  };
  readonly extract: ExtractConfig;
  readonly dashboard: DashboardConfig;
}

/** Raised for anything that would leave the process running on a value nobody wrote. */
export class ConfigError extends Error {
  /**
   * One entry per problem, each already naming its own source.
   *
   * Kept apart from the joined message so a front door can report them the
   * way it reports everything else — the API logs one line each, rather than
   * pushing a paragraph through a one-line-per-entry log format.
   */
  readonly problems: readonly string[];

  constructor(summary: string, problems: readonly string[] = []) {
    super(problems.length > 0 ? [summary, ...problems.map((problem) => `  - ${problem}`)].join("\n") : summary);
    this.name = "ConfigError";
    this.problems = problems.length > 0 ? problems : [summary];
  }
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every configurable leaf, as path segments. A list (`allowedPorts`) and an
 * unset optional (`null`) are leaves: they are values an operator sets, not
 * branches to descend into.
 */
export function configLeafPaths(node: unknown = DEFAULT_CONFIG_INPUT, prefix: readonly string[] = []): string[][] {
  if (!isPlainObject(node)) return [[...prefix]];
  return Object.entries(node).flatMap(([key, value]) => configLeafPaths(value, [...prefix, key]));
}

/** `extract.cache.ttlMs` becomes `SEARCHICUS_EXTRACT_CACHE_TTL_MS`. */
export function envNameForPath(segments: readonly string[]): string {
  const upper = segments.map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase());
  return [ENV_PREFIX, ...upper].join("_");
}

interface Overlay {
  readonly values: PlainObject;
  /** Dotted path to the environment variable that set it, for error messages. */
  readonly sources: Map<string, string>;
}

/**
 * Everything the environment has to say, shaped like the tree.
 *
 * Derived from the default tree rather than from a list of names, so a new
 * setting is overridable the moment it has a default and cannot be given a
 * name that does not match its path.
 */
function environmentOverlay(env: NodeJS.ProcessEnv): Overlay {
  const values: PlainObject = {};
  const sources = new Map<string, string>();

  for (const segments of configLeafPaths()) {
    const name = envNameForPath(segments);
    const raw = env[name];
    if (raw === undefined) continue;

    let node = values;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainObject(node[segment])) node[segment] = {};
      node = node[segment] as PlainObject;
    }
    node[segments[segments.length - 1] as string] = raw;
    sources.set(segments.join("."), name);
  }

  return { values, sources };
}

/**
 * Layers one source over another, key by key.
 *
 * Unknown keys are carried through rather than dropped, so the strict schema
 * is what reports them — a typo should name itself, not vanish.
 */
function merge(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;

  const merged: PlainObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in base ? merge(base[key], value) : value;
  }
  return merged;
}

/** Reads and parses one YAML file into a mapping. */
function readConfigFile(file: string): PlainObject {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read the configuration file ${file}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigError(`${file} is not valid YAML: ${detail}`);
  }

  // An empty file is a file an operator started and left; it means "defaults".
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `${file} must contain a mapping of settings, not ${Array.isArray(parsed) ? "a list" : typeof parsed}`,
    );
  }

  return parsed;
}

/**
 * Which file to read, if any.
 *
 * A file named explicitly and then missing is an error: the operator said
 * where their settings are, and running on defaults instead would be the
 * silent failure this module exists to avoid. The conventional path is
 * optional, because most deployments have no file at all.
 */
export function discoverConfigFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env[CONFIG_PATH_ENV]?.trim();
  if (named) {
    const resolved = path.resolve(named);
    if (!existsSync(resolved)) {
      throw new ConfigError(`${CONFIG_PATH_ENV} names ${resolved}, which does not exist`);
    }
    return resolved;
  }

  const conventional = path.join(applicationRoot(), DEFAULT_CONFIG_FILENAME);
  return existsSync(conventional) ? conventional : null;
}

export interface LoadConfigOptions {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** An explicit file. `null` skips file loading; omitted discovers one. */
  readonly file?: string | null;
}

/**
 * Builds the configuration this process runs on, or explains why it cannot.
 *
 * Called once, at startup. Nothing below a front door reads the environment
 * for itself: a value read at its point of use is a value that cannot be
 * reported, overridden in a test, or found by someone reading the config.
 */
export function loadConfig(options: LoadConfigOptions = {}): SearchicusConfig {
  const env = options.env ?? process.env;
  const file = options.file === undefined ? discoverConfigFile(env) : options.file;
  const fromFile = file === null ? {} : readConfigFile(file);
  const overlay = environmentOverlay(env);

  const merged = merge(merge(DEFAULT_CONFIG_INPUT, fromFile), overlay.values);
  const result = SearchicusConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError("Invalid searchicus configuration:", describeIssues(result.error, overlay.sources, file));
  }

  log.debug("configuration loaded", { file: file ?? "defaults", overrides: overlay.sources.size });
  return finalize(result.data);
}

/**
 * Reports every problem at once, each against the place it came from.
 *
 * One at a time would mean one restart per typo, and the name to fix is not
 * the same word in both sources: the file says `extract.maxBytes` and the
 * environment says `SEARCHICUS_EXTRACT_MAX_BYTES`.
 */
function describeIssues(error: z.ZodError, sources: Map<string, string>, file: string | null): string[] {
  return error.issues.flatMap((issue) => {
    const at = issue.path.map(String);
    // A strict object reports unknown keys against the parent that holds them.
    const keys = issue.code === "unrecognized_keys" ? issue.keys : [undefined];
    return keys.map((key) => {
      const dotted = [...at, ...(key === undefined ? [] : [key])].join(".");
      const source = sources.get(dotted) ?? (file === null ? "default" : file);
      return `${dotted || "(root)"} (${source}): ${issue.message}`;
    });
  });
}

/**
 * Turns validated settings into the shapes the application uses.
 *
 * Nothing here is read from a source; these are the derivations, gathered so
 * that none of them happens twice: the port list becomes the set the address
 * policy tests against, and the two ceilings are applied to the values they
 * are ceilings over.
 */
function finalize(parsed: ParsedConfig): SearchicusConfig {
  return {
    ...parsed,
    extract: {
      ...parsed.extract,
      maxDocumentBytes: documentCap(parsed.extract.maxDocumentBytes, parsed.extract.maxBytes),
      allowedPorts: new Set(parsed.extract.allowedPorts),
    },
    dashboard: dashboardWindows(parsed.dashboard),
  };
}

/**
 * The dashboard windows, held under the ceiling documented to cover them.
 *
 * `maxLimit` bounds what a caller may ask the process to read, and the two
 * window sizes are what it reads when a caller asks for nothing. A default
 * above the ceiling would be the one request nobody could make — the
 * dashboard's own — so an operator who lowered `maxLimit` to protect the
 * archive would still have every unqualified query read past it.
 */
function dashboardWindows(dashboard: ParsedConfig["dashboard"]): DashboardConfig {
  return {
    maxLimit: dashboard.maxLimit,
    metricsWindow: underCeiling("dashboard.metricsWindow", dashboard.metricsWindow, dashboard.maxLimit),
    searchPageSize: underCeiling("dashboard.searchPageSize", dashboard.searchPageSize, dashboard.maxLimit),
  };
}

/** Clamps one window to the ceiling, saying so rather than silently differing. */
function underCeiling(setting: string, requested: number, ceiling: number): number {
  if (requested <= ceiling) return requested;

  log.warn("dashboard window lowered to the configured ceiling", {
    setting,
    requested,
    applied: ceiling,
    ceiling: "dashboard.maxLimit",
  });
  return ceiling;
}

/**
 * The document cap, clamped to the transfer budget.
 *
 * A cap above the tripwire is unreachable by construction — the render stops
 * fetching before a document could ever reach it — so the failure it exists
 * to produce could never happen, and an oversized page would be reported as
 * one that could not be loaded instead.
 *
 * Clamped and said out loud rather than rejected: the pair is still a
 * working configuration, just not the one it appears to be, and a limit that
 * silently means something else is how an afternoon disappears.
 */
function documentCap(requested: number, transfer: number): number {
  if (requested <= transfer) return requested;

  log.warn("extraction document cap lowered to the transfer budget", {
    requested,
    applied: transfer,
    transferBudget: transfer,
  });
  return transfer;
}

/** One setting that is not what it would have been left alone. */
export interface ChangedSetting {
  /** Dotted path, as written in the file: `extract.cache.ttlMs`. */
  readonly path: string;
  /** The value in force, rendered for a log line. */
  readonly value: string;
  /** Where it came from: an environment variable name, or the file. */
  readonly source: string;
}

/**
 * Everything this process is running on that it was not born with.
 *
 * Only the differences, on purpose. A service that printed all forty settings
 * at every boot would bury the three an operator actually set, and the
 * defaults are already written down in `config.example.yaml`. What cannot be
 * read anywhere else is which layer won, so that is what this reports.
 */
export function changedSettings(config: SearchicusConfig, options: LoadConfigOptions = {}): ChangedSetting[] {
  const env = options.env ?? process.env;
  const file = options.file ?? null;
  const changed: ChangedSetting[] = [];

  for (const segments of configLeafPaths()) {
    const value = renderSetting(valueAt(config, segments));
    if (value === renderSetting(valueAt(DEFAULT_CONFIG_INPUT, segments))) continue;

    const name = envNameForPath(segments);
    changed.push({
      path: segments.join("."),
      value,
      // Not from the environment and not the default leaves one possibility.
      source: env[name] !== undefined ? name : (file ?? "config file"),
    });
  }

  return changed;
}

function valueAt(root: unknown, segments: readonly string[]): unknown {
  let node: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Renders a setting the way a log line and a comparison both want it. */
function renderSetting(value: unknown): string {
  if (value instanceof Set) return [...value].join(",");
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

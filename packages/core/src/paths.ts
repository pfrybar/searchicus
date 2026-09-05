import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envOptOut } from "./env.js";

/** The persistent state root, relative to the application root. */
export const DEFAULT_DATA_DIR = ".searchicus";
/** Chromium profiles remain isolated below the shared persistent state root. */
export const DEFAULT_PROFILE_ROOT = "profile";
/** Name of the shared, application-owned search archive database. */
export const DEFAULT_STORE_FILENAME = "searches.sqlite";
/** How far up to look for the workspace root before giving up. */
const MAX_ROOT_SEARCH_DEPTH = 8;

let applicationRootCache: string | undefined;

/**
 * The application root, found from this module rather than from the working
 * directory.
 *
 * The working directory is not a stable answer to "where does this machine
 * keep its searches". Nothing here is project-scoped the way git or npm state
 * is: profiles are per-surface machine state and the archive is a history of
 * every search run. But `npm run -w <package>` sets the working directory to
 * that package, so the API resolved `packages/api/.searchicus` while the CLI
 * resolved the repository root — and the archive they are explicitly designed
 * to share was silently two databases.
 *
 * Walking up from this file to the workspace root gives one answer per
 * checkout however the process was started. The marker is a package.json
 * declaring `workspaces`, which is this repository's root and not any package
 * within it. Anything unrecognised falls back to the working directory, which
 * is what an installation as somebody else's dependency would hit.
 */
export function applicationRoot(): string {
  // Memoized: this reads the filesystem, and the answer cannot change while
  // the process runs.
  if (applicationRootCache !== undefined) return applicationRootCache;

  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < MAX_ROOT_SEARCH_DEPTH; depth++) {
    if (declaresWorkspaces(path.join(directory, "package.json"))) {
      applicationRootCache = directory;
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  applicationRootCache = process.cwd();
  return applicationRootCache;
}

/** True for the manifest of an npm workspaces root, ignoring anything else. */
function declaresWorkspaces(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { workspaces?: unknown };
    return manifest.workspaces !== undefined;
  } catch {
    // Absent, unreadable, or not JSON. All mean "not the root".
    return false;
  }
}

/**
 * Resolves the root for all persistent searchicus state. Override this one
 * value to move both Chromium profiles and the SQLite archive together.
 */
export function defaultDataDir(): string {
  return process.env.SEARCHICUS_DATA_DIR ?? path.join(applicationRoot(), DEFAULT_DATA_DIR);
}

/** Resolves one surface's Chromium user-data directory. */
export function defaultProfileDir(surface: string): string {
  return process.env.SEARCHICUS_PROFILE_DIR ?? path.join(defaultDataDir(), DEFAULT_PROFILE_ROOT, surface);
}

/** Resolves the shared application archive path, separate from Chromium data. */
export function defaultStorePath(): string {
  return process.env.SEARCHICUS_STORE_PATH ?? path.join(defaultDataDir(), DEFAULT_STORE_FILENAME);
}

/** Archiving is on unless explicitly disabled for a process. */
export function searchArchiveEnabled(): boolean {
  return envOptOut(process.env.SEARCHICUS_STORE);
}

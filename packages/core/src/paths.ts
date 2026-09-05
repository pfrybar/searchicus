import path from "node:path";
import { envOptOut } from "./env.js";

/** The persistent state root relative to a front door's working directory. */
export const DEFAULT_DATA_DIR = ".searchicus";
/** Chromium profiles remain isolated below the shared persistent state root. */
export const DEFAULT_PROFILE_ROOT = "profile";
/** Name of the shared, application-owned search archive database. */
export const DEFAULT_STORE_FILENAME = "searches.sqlite";

/**
 * Resolves the root for all persistent searchicus state. Override this one
 * value to move both Chromium profiles and the SQLite archive together.
 */
export function defaultDataDir(): string {
  return process.env.SEARCHICUS_DATA_DIR ?? path.join(process.cwd(), DEFAULT_DATA_DIR);
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

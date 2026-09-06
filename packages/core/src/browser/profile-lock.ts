import { lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

/** Chromium's per-profile single-writer sentinel. */
export const PROFILE_LOCK_FILENAME = "SingletonLock";

/** A lock whose owner is known to be a different machine. */
export interface StaleProfileLock {
  /** Absolute or profile-relative path to Chromium's lock symlink. */
  readonly path: string;
  /** Host encoded by Chromium in the symlink target. */
  readonly ownerHostname: string;
  /** The host attempting to open this profile. */
  readonly currentHostname: string;
}

/**
 * Finds Chromium's profile lock when it names another host.
 *
 * `existsSync` intentionally cannot be used here: a stale SingletonLock is a
 * dangling symlink, which exists on disk but appears absent to an existence
 * check that follows it. `lstatSync` inspects the link itself instead.
 */
export function findStaleProfileLock(profileDir: string, currentHostname = hostname()): StaleProfileLock | undefined {
  const lockPath = path.join(profileDir, PROFILE_LOCK_FILENAME);

  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch {
    return undefined;
  }
  if (!stat.isSymbolicLink()) return undefined;

  let ownerHostname: string | undefined;
  try {
    ownerHostname = lockOwnerHostname(readlinkSync(lockPath));
  } catch {
    return undefined;
  }
  if (!ownerHostname || ownerHostname === currentHostname) return undefined;

  return { path: lockPath, ownerHostname, currentHostname };
}

/**
 * Removes a known stale lock. Call only after findStaleProfileLock() and only
 * when the operator explicitly opted into automatic recovery.
 */
export function removeStaleProfileLock(lock: StaleProfileLock): void {
  unlinkSync(lock.path);
}

/** Chromium encodes a lock owner as `<hostname>-<pid>`. */
function lockOwnerHostname(target: string): string | undefined {
  // Keep the final path component: a platform may represent a link target
  // relatively, while the hostname/pid portion itself contains no slashes.
  const name = path.basename(target);
  const separator = name.lastIndexOf("-");
  if (separator <= 0) return undefined;

  const owner = name.slice(0, separator);
  const pid = name.slice(separator + 1);
  return /^\d+$/.test(pid) && owner.length > 0 ? owner : undefined;
}

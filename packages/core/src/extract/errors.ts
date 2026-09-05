import type { ExtractFailureKind } from "./types.js";

/**
 * Extraction is off. Rendering arbitrary caller-supplied URLs is a real
 * capability with real exposure, so it is opt-in per deployment rather than
 * something that arrives switched on with an upgrade.
 */
export class ExtractionDisabledError extends Error {
  constructor() {
    super(
      "Extraction is not enabled on this server. An operator must set " +
        "SEARCHICUS_EXTRACT_ENABLED=true, having first restricted the process's outbound network access.",
    );
    this.name = "ExtractionDisabledError";
  }
}

/**
 * The caller's request is wrong, and saying exactly how is safe: these
 * failures describe input the caller already holds, so a precise message
 * discloses nothing and lets them fix it without guessing.
 *
 * The message is the whole payload, deliberately. This carried a `kind` from
 * ExtractFailureKind too, which nothing ever read: these are raised before an
 * extraction attempt exists, so they never reach the archive, and every front
 * door answers them with the message. An unread label is not free — it drifted
 * without anyone noticing, and a maxChars complaint shipped as "invalid_url".
 * If a stable machine-readable code is wanted for the 400, it should be
 * designed for that surface rather than inherited from the archive's union.
 */
export class ExtractRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractRequestError";
  }
}

/**
 * Extraction was refused before it started, because too many callers are
 * already waiting.
 *
 * Separate from ExtractFailedError on purpose: nothing was attempted, so
 * there is no page outcome to record and recording one would put the server's
 * own load into a table that exists to describe documents. A caller should
 * retry rather than conclude the URL cannot be read.
 */
export class ExtractionBusyError extends Error {
  constructor(public readonly queued: number) {
    super(`Too many extractions are already queued (${queued}). Try again shortly.`);
    this.name = "ExtractionBusyError";
  }
}

/**
 * Extraction ran and did not produce content.
 *
 * Messages here are written to be safe to return verbatim. The failure is
 * about a host the caller does not control and may not be able to see, so a
 * detailed one leaks: resolved addresses, DNS behaviour, internal topology,
 * and which internal names exist are all inferable from a specific enough
 * error. The real cause is attached for logs and never serialized.
 */
export class ExtractFailedError extends Error {
  constructor(
    readonly kind: ExtractFailureKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ExtractFailedError";
    if (cause !== undefined) this.cause = cause;
  }

  /** The address policy refused the destination. Deliberately says no more. */
  static blockedAddress(cause?: unknown): ExtractFailedError {
    return new ExtractFailedError("blocked_address", "That URL could not be fetched.", cause);
  }
}

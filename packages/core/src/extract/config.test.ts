import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_CONFIG } from "./config.js";

describe("DEFAULT_EXTRACT_CONFIG", () => {
  it("bounds a document below the transfer budget it is fetched within", () => {
    // The two caps guard different things — one the parse, one the fetch —
    // but a document cap above the transfer tripwire would be unreachable by
    // construction, and the failure it exists to produce could never happen.
    expect(DEFAULT_EXTRACT_CONFIG.maxDocumentBytes).toBeLessThan(DEFAULT_EXTRACT_CONFIG.maxBytes);
  });

  it("leaves the whole timing budget inside the end-to-end deadline", () => {
    // Navigation, settle, a dwell of up to ~5.3s, and the capture all have to
    // fit; a default that could not would fail slow pages by construction.
    const { navigationTimeoutMs, settleTimeoutMs, timeoutMs } = DEFAULT_EXTRACT_CONFIG;
    expect(navigationTimeoutMs + settleTimeoutMs + 5_300).toBeLessThan(timeoutMs);
  });
});

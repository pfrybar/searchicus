import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_CONFIG, extractConfigFromEnv } from "./config.js";

describe("extractConfigFromEnv", () => {
  it("is off unless explicitly switched on", () => {
    expect(extractConfigFromEnv({}).enabled).toBe(false);
    // Opt-in, so only an unambiguous yes counts — but every unambiguous yes
    // does. An operator who writes "yes" means yes, and used to get a
    // silently disabled endpoint with nothing to explain it.
    for (const value of ["true", "TRUE", " true ", "1", "yes", "on"]) {
      expect(extractConfigFromEnv({ SEARCHICUS_EXTRACT_ENABLED: value }).enabled, value).toBe(true);
    }
    // Anything that is not a yes leaves it off, including a near miss.
    for (const value of ["false", "0", "no", "off", "", "tru", "maybe"]) {
      expect(extractConfigFromEnv({ SEARCHICUS_EXTRACT_ENABLED: value }).enabled, value).toBe(false);
    }
  });

  it("reads every limit from the environment", () => {
    const config = extractConfigFromEnv({
      SEARCHICUS_EXTRACT_MAX_CONCURRENT: "4",
      SEARCHICUS_EXTRACT_NAVIGATION_TIMEOUT_MS: "5000",
      SEARCHICUS_EXTRACT_SETTLE_TIMEOUT_MS: "0",
      SEARCHICUS_EXTRACT_TIMEOUT_MS: "20000",
      SEARCHICUS_EXTRACT_MAX_BYTES: "1048576",
      SEARCHICUS_EXTRACT_MAX_DOC_BYTES: "524288",
      SEARCHICUS_EXTRACT_MAX_REDIRECTS: "0",
      SEARCHICUS_EXTRACT_ALLOWED_PORTS: "80, 443, 8443",
      SEARCHICUS_EXTRACT_DWELL: "false",
    });

    expect(config).toMatchObject({
      maxConcurrent: 4,
      navigationTimeoutMs: 5_000,
      settleTimeoutMs: 0,
      timeoutMs: 20_000,
      maxBytes: 1_048_576,
      maxDocumentBytes: 524_288,
      maxRedirects: 0,
      dwell: false,
    });
    expect([...config.allowedPorts]).toEqual([80, 443, 8443]);
  });

  it("bounds a document below the transfer budget it is fetched within", () => {
    // The two caps guard different things — one the parse, one the fetch —
    // but a document cap above the transfer tripwire would be unreachable by
    // construction, and the failure it exists to produce could never happen.
    expect(DEFAULT_EXTRACT_CONFIG.maxDocumentBytes).toBeLessThan(DEFAULT_EXTRACT_CONFIG.maxBytes);
  });

  it("keeps a document cap that outruns the tripwire inside it", () => {
    // The same rule on the operator's path: a misdeclared document cap must
    // not sail past the transfer budget, or the failure it exists to produce
    // would be unreachable by construction.
    const config = extractConfigFromEnv({
      SEARCHICUS_EXTRACT_MAX_BYTES: "1048576",
      SEARCHICUS_EXTRACT_MAX_DOC_BYTES: "4194304",
    });
    expect(config.maxDocumentBytes).toBe(config.maxBytes);

    // A cap at or under the tripwire is respected as written.
    const normal = extractConfigFromEnv({
      SEARCHICUS_EXTRACT_MAX_BYTES: "1048576",
      SEARCHICUS_EXTRACT_MAX_DOC_BYTES: "524288",
    });
    expect(normal.maxDocumentBytes).toBe(524_288);
  });

  it("falls back rather than throwing on an unusable value", () => {
    // A typo in one limit must not stop a server booting, and the default is
    // always the safe direction.
    const config = extractConfigFromEnv({
      SEARCHICUS_EXTRACT_MAX_CONCURRENT: "lots",
      SEARCHICUS_EXTRACT_TIMEOUT_MS: "-1",
      SEARCHICUS_EXTRACT_NAVIGATION_TIMEOUT_MS: "0",
      SEARCHICUS_EXTRACT_ALLOWED_PORTS: "http,https",
    });

    expect(config.maxConcurrent).toBe(DEFAULT_EXTRACT_CONFIG.maxConcurrent);
    expect(config.timeoutMs).toBe(DEFAULT_EXTRACT_CONFIG.timeoutMs);
    expect(config.navigationTimeoutMs).toBe(DEFAULT_EXTRACT_CONFIG.navigationTimeoutMs);
    expect([...config.allowedPorts]).toEqual([...DEFAULT_EXTRACT_CONFIG.allowedPorts]);
  });

  it("leaves the whole timing budget inside the end-to-end deadline", () => {
    // Navigation, settle, a dwell of up to ~5.3s, and the capture all have to
    // fit; a default that could not would fail slow pages by construction.
    const { navigationTimeoutMs, settleTimeoutMs, timeoutMs } = DEFAULT_EXTRACT_CONFIG;
    expect(navigationTimeoutMs + settleTimeoutMs + 5_300).toBeLessThan(timeoutMs);
  });
});

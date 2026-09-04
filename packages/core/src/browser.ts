/**
 * Playwright-backed public entry point.
 *
 * Kept as a top-level facade so consumers continue to import from
 * `@searchicus/core/browser`, while the browser implementation remains
 * grouped under `src/browser/` and separate from core's browser-free entry.
 */
export * from "./browser/session.js";
export * from "./browser/stealth.js";
export * from "./browser/human.js";
export * from "./browser/dwell.js";
export * from "./browser/click-through.js";

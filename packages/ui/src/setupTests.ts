import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// RTL only auto-registers this cleanup when vitest's `globals` option is on;
// we're not using globals, so do it explicitly.
afterEach(cleanup);

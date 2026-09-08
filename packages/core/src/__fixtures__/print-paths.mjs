// Prints the resolved persistent-state paths, for a test that has to compare
// them across working directories. The resolution is a property of the
// process, so it cannot be observed from inside one test run.
import { DEFAULT_CONFIG_INPUT } from "../../dist/config.js";
import { resolveDataDir, resolveProfileDir, resolveStorePath } from "../../dist/paths.js";

const paths = DEFAULT_CONFIG_INPUT.paths;

process.stdout.write(
  JSON.stringify({
    cwd: process.cwd(),
    dataDir: resolveDataDir(paths),
    profile: resolveProfileDir(paths, "api"),
    store: resolveStorePath(paths),
  }),
);

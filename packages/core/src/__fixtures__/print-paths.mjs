// Prints the resolved persistent-state paths, for a test that has to compare
// them across working directories. The resolution is a property of the
// process, so it cannot be observed from inside one test run.
import { defaultDataDir, defaultProfileDir, defaultStorePath } from "../../dist/paths.js";

process.stdout.write(
  JSON.stringify({ cwd: process.cwd(), dataDir: defaultDataDir(), profile: defaultProfileDir("api"), store: defaultStorePath() }),
);

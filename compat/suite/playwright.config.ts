import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * A tiny suite for compatibility tests: one release's reporter reporting to
 * another release's server. It opens no browser; the tests exist to be
 * reported on, one of each thing a reporter sends (see suite.spec.ts).
 *
 * The reporter under test is a path in `CAMERI_REPORTER`: the last published
 * reporter, or this repository's build. Where it reports to comes from its own
 * environment (`CAMERI_SERVER_URL`, `CAMERI_RECORD_KEY`, `CAMERI_RUN_KEY`).
 *
 * Run by `apps/server/src/compat/previous-reporter.test.ts` and by the
 * `compat-reporter` job in `.github/workflows/test.yml`.
 */
const reporter = process.env.CAMERI_REPORTER;
if (!reporter) throw new Error("set CAMERI_REPORTER to the path of the reporter under test");

export default defineConfig({
  testDir: ".",
  // One worker and a fixed order, so every run reports the same thing.
  workers: 1,
  // For the flaky test: it fails once and passes on its retry.
  retries: 1,
  // Outside the repository: nothing here is worth keeping.
  outputDir: join(tmpdir(), "cameri-compat-results"),
  reporter: [["list"], [reporter]],
});

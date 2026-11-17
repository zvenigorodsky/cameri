/**
 * This server against one released reporter, as published to npm.
 *
 * The reporter is the real package, run by Playwright over the suite in
 * `compat/suite`, reporting over HTTP to this server running in-process. So it
 * checks behaviour, not just the shape of the schemas: that release's reporter
 * has to open a run, stream results, upload an attachment and sign off, and
 * the run has to end up as that reporter would expect.
 *
 *   COMPAT_REPORTER=<unpacked package> TEST_DATABASE_URL=postgres://…/cameri_test \
 *     pnpm --filter @camerihq/server exec node --import tsx --test src/compat/released-reporter.test.ts
 *
 * `COMPAT_REPORTER` is an unpacked npm tarball (`npm pack
 * @camerihq/playwright-reporter@<version>`). Which versions get checked is not
 * decided here: `scripts/compat-plan.ts` lists every published reporter this
 * build has to work with, and CI runs this once per version, with this build
 * versioned as what it would ship as (see the `compat-*` jobs in
 * `.github/workflows/test.yml`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { attachments, projects, recordKeys, runs, shards, testAttempts, tests } from "@camerihq/db";
import { serve, type ServerType } from "@hono/node-server";
import { and, asc, eq } from "drizzle-orm";
import { createApp } from "../app.ts";
import { hashRecordKey } from "../auth.ts";
import { createContext, type AppContext } from "../context.ts";
import { loadEnv } from "../env.ts";
import { migrateToLatest } from "../migrations.ts";

const COMPAT_REPORTER = process.env.COMPAT_REPORTER;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// From the URL rather than `import.meta.dirname`, which Node 20.10 (in CI's
// matrix) does not have.
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

/** The reporter package under test, as its manifest describes it. */
const reporter = COMPAT_REPORTER
  ? (JSON.parse(readFileSync(join(COMPAT_REPORTER, "package.json"), "utf8")) as {
      version: string;
      main: string;
    })
  : undefined;

describe(
  `this server, with reporter ${reporter?.version ?? "(none given)"}`,
  {
    skip:
      reporter && TEST_DATABASE_URL ? false : "set COMPAT_REPORTER and TEST_DATABASE_URL to run",
  },
  () => {
    let context: AppContext;
    let server: ServerType;
    let serverUrl: string;
    let storageDir: string;
    let projectId: string;
    let recordKey: string;

    before(async () => {
      // The port is needed before the server exists: upload URLs are built
      // from PUBLIC_URL, and the reporter uploads to whatever it is given.
      const port = await freePort();
      serverUrl = `http://127.0.0.1:${port}`;
      storageDir = await mkdtemp(join(tmpdir(), "cameri-compat-storage-"));

      const env = loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_URL: serverUrl,
        STORAGE_LOCAL_DIR: storageDir,
      });
      await migrateToLatest(env);
      context = createContext(env);
      server = serve({ fetch: createApp(context).fetch, port, hostname: "127.0.0.1" });

      const [project] = await context.db
        .insert(projects)
        .values({ name: "compat", slug: `compat-${randomUUID()}` })
        .returning({ id: projects.id });
      assert.ok(project);
      projectId = project.id;

      recordKey = `cam_compat_${randomUUID()}`;
      await context.db
        .insert(recordKeys)
        .values({ projectId, name: "compat", keyHash: hashRecordKey(recordKey) });
    });

    after(async () => {
      // Cascades to the record key, runs, shards, attempts and attachments.
      await context.db.delete(projects).where(eq(projects.id, projectId));
      await new Promise<void>((done) => server.close(() => done()));
      await context.close();
      await rm(storageDir, { recursive: true, force: true });
    });

    it("takes a whole run from it, the way that release expects", async () => {
      const runKey = `compat-${randomUUID()}`;
      const { code, output } = await runSuite({
        CAMERI_REPORTER: resolve(COMPAT_REPORTER as string, (reporter as { main: string }).main),
        CAMERI_SERVER_URL: serverUrl,
        CAMERI_RECORD_KEY: recordKey,
        CAMERI_RUN_KEY: runKey,
        CAMERI_DEBUG: "1",
      });

      // The reporter never fails the suite, so its own log is where a refusal
      // shows: an incompatible server turns reporting off.
      assert.doesNotMatch(output, /reporting is now off/, output);
      assert.equal(code, 0, output);

      const [run] = await context.db
        .select()
        .from(runs)
        .where(and(eq(runs.projectId, projectId), eq(runs.runKey, runKey)));
      assert.ok(run, `no run reached the server:\n${output}`);
      assert.equal(run.status, "passed", output);

      const shardRows = await context.db.select().from(shards).where(eq(shards.runId, run.id));
      assert.deepEqual(
        shardRows.map((shard) => shard.status),
        ["completed"],
      );

      const attempts = await context.db
        .select({ title: tests.title, retry: testAttempts.retry, status: testAttempts.status })
        .from(testAttempts)
        .innerJoin(tests, eq(testAttempts.testRef, tests.id))
        .where(eq(testAttempts.runId, run.id))
        .orderBy(asc(tests.title), asc(testAttempts.retry));
      assert.deepEqual(attempts, [
        { title: "attaches a file", retry: 0, status: "passed" },
        { title: "fails once, then passes on retry", retry: 0, status: "failed" },
        { title: "fails once, then passes on retry", retry: 1, status: "passed" },
        { title: "is skipped", retry: 0, status: "skipped" },
        { title: "passes", retry: 0, status: "passed" },
      ]);

      const uploaded = await context.db
        .select({ name: attachments.name, uploadedAt: attachments.uploadedAt })
        .from(attachments)
        .innerJoin(testAttempts, eq(attachments.attemptId, testAttempts.id))
        .where(and(eq(testAttempts.runId, run.id), eq(attachments.name, "note")));
      assert.equal(uploaded.length, 1, "the attachment was not reported");
      assert.ok(uploaded[0]?.uploadedAt, "the attachment was reported, but its bytes never arrived");
    });
  },
);

/** Runs `compat/suite` with Playwright, and returns its exit code and output. */
function runSuite(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(
      join(REPO, "node_modules/.bin/playwright"),
      ["test", "--config", join(REPO, "compat/suite/playwright.config.ts")],
      { cwd: REPO, env: { ...process.env, ...env } },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, output }));
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? done(address.port) : fail(new Error("no port")),
      );
    });
  });
}

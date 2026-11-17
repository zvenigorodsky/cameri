/**
 * The reporter's half of version checking, against a stand-in server that
 * answers `/health` with whatever version header a test asks for, and records
 * every request it gets.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { VERSION_HEADER } from "@camerihq/contract/versioning";
import type { FullConfig, FullResult, Suite } from "@playwright/test/reporter";
import { IngestClient, IngestError, REPORTER_VERSION } from "./client.ts";
import type { ResolvedConfig } from "./config.ts";
import CameriReporter from "./index.ts";

/** A server version this reporter is not compatible with: its next major. */
const NEXT_MAJOR = `${Number(REPORTER_VERSION.split(".")[0]) + 1}.0.0`;

describe("version checking", () => {
  let server: Server;
  let serverUrl: string;
  /** How `/health` answers. A `version` of `undefined` sends no header. */
  let health: { status: number; version: string | undefined };
  /** How every other route answers. */
  let reply: { status: number; body: unknown };
  /** `METHOD path version-header` for every request, in order. */
  let requests: string[];

  before(async () => {
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers[VERSION_HEADER] ?? "-"}`);
      request.resume();
      request.on("end", () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (request.url?.endsWith("/health")) {
          if (health.version !== undefined) headers[VERSION_HEADER] = health.version;
          response.writeHead(health.status, headers).end(JSON.stringify({ ok: true }));
        } else {
          headers[VERSION_HEADER] = REPORTER_VERSION;
          response.writeHead(reply.status, headers).end(JSON.stringify(reply.body));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    health = { status: 200, version: REPORTER_VERSION };
    reply = { status: 200, body: { shardStatus: "running" } };
    requests = [];
  });

  function client(): IngestClient {
    const config: ResolvedConfig = {
      serverUrl,
      recordKey: "cam_test",
      runKey: undefined,
      expectedShards: undefined,
      shardIndex: undefined,
      enabled: true,
      batchSize: 50,
      flushIntervalMs: 2_000,
      timeoutMs: 5_000,
      maxRetries: 0,
      debug: false,
    };
    return new IngestClient(config);
  }

  // --- the handshake ---------------------------------------------------------------

  it("asks /health for the server's version, and accepts a compatible one", async () => {
    await client().handshake();
    assert.deepEqual(requests, [`GET /api/v1/health ${REPORTER_VERSION}`]);
  });

  it("refuses a server from before versioning, which sends no version", async () => {
    health.version = undefined;
    await assert.rejects(client().handshake(), (error: unknown) => {
      assert.ok(error instanceof IngestError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /server \(unknown version\) is not compatible with reporter/);
      return true;
    });
  });

  it("refuses a server from an incompatible release", async () => {
    health.version = NEXT_MAJOR;
    await assert.rejects(client().handshake(), /is not compatible with reporter/);
  });

  it("does not mistake a proxy's error, which has no version header, for an old server", async () => {
    health = { status: 502, version: undefined };
    await assert.rejects(client().handshake(), (error: unknown) => {
      assert.ok(error instanceof IngestError);
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /compatible/);
      return true;
    });
  });

  // --- every other request ---------------------------------------------------------

  it("sends its version on every request", async () => {
    await client().heartbeat({ runId: "run", shardId: "shard" });
    assert.deepEqual(requests, [`POST /api/v1/shards/heartbeat ${REPORTER_VERSION}`]);
  });

  it("passes on the server's own reason when the server refuses it", async () => {
    reply = {
      status: 426,
      body: { error: { code: "version_unsupported", message: "not compatible here." } },
    };
    await assert.rejects(client().heartbeat({ runId: "run", shardId: "shard" }), (error) => {
      assert.ok(error instanceof IngestError);
      assert.equal(error.status, 426);
      assert.equal(error.retryable, false);
      assert.match(error.message, /426 not compatible here\.$/);
      return true;
    });
  });

  // --- the reporter, end to end -----------------------------------------------------

  it("writes nothing to an incompatible server, and turns reporting off", async () => {
    health.version = undefined;
    const reporter = new CameriReporter({
      serverUrl,
      recordKey: "cam_test",
      runKey: "version-test",
      maxRetries: 0,
    });

    reporter.onBegin({ version: "1.0.0", shard: null } as unknown as FullConfig, {} as Suite);
    await reporter.onEnd({ status: "passed" } as FullResult);

    // The handshake and nothing after it: no run opened, no sign-off sent.
    assert.deepEqual(requests, [`GET /api/v1/health ${REPORTER_VERSION}`]);
  });
});

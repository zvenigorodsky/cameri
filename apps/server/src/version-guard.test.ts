/**
 * The server's half of version checking, and the compatibility rule both
 * halves share. No database: the guard answers before anything that would
 * query one, and the pool only connects on first use.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { CLIENT_VERSION_HEADER } from "@camerihq/contract/constants";
import { areVersionsCompatible, VERSION_HEADER } from "@camerihq/contract/versioning";
import serverPackage from "../package.json" with { type: "json" };
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";
import { loadEnv } from "./env.ts";
import { SERVER_VERSION } from "./version-guard.ts";

/** A client version this server is not compatible with: its next major. */
const NEXT_MAJOR = `${Number(SERVER_VERSION.split(".")[0]) + 1}.0.0`;

describe("version compatibility (npm ^ rules)", () => {
  const cases: Array<[server: string, client: string | undefined, compatible: boolean]> = [
    ["1.4.0", "1.4.0", true],
    ["1.4.0", "1.0.0", true],
    ["1.4.0", "1.9.3", true],
    ["1.4.0", "2.0.0", false],
    ["2.0.0", "1.9.3", false],
    ["0.3.1", "0.3.7", true],
    ["0.3.1", "0.4.0", false],
    ["0.0.3", "0.0.3", true],
    ["0.0.3", "0.0.4", false],
    ["1.4.0", "1.4.1-beta.2", true],
    ["1.4.0", undefined, false],
    ["1.4.0", "", false],
    ["1.4.0", "1", false],
    ["1.4.0", "v1.4.0", false],
  ];
  for (const [server, client, compatible] of cases) {
    it(`server ${server}, client ${client ?? "(none)"}: ${compatible ? "compatible" : "refused"}`, () => {
      assert.equal(areVersionsCompatible({ server, client }), compatible);
      // Symmetric: swapping the two never changes the answer.
      if (client) assert.equal(areVersionsCompatible({ server: client, client: server }), compatible);
    });
  }
});

describe("version guard", () => {
  const context = createContext(
    loadEnv({ ...process.env, DATABASE_URL: "postgres://unused@127.0.0.1:1/unused" }),
  );
  const server = createApp(context);

  after(() => context.close());

  async function postRuns(headers: Record<string, string>): Promise<Response> {
    return server.request("/api/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ runKey: "version-test" }),
    });
  }

  it("is the server's own package.json version", () => {
    assert.equal(SERVER_VERSION, serverPackage.version);
  });

  it("refuses a client from before versioning, and says why", async () => {
    const response = await postRuns({ [CLIENT_VERSION_HEADER]: "playwright-reporter/0.0.1" });

    assert.equal(response.status, 426);
    assert.equal(response.headers.get(VERSION_HEADER), SERVER_VERSION);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "version_unsupported");
    assert.match(
      body.error.message,
      /^playwright-reporter\/0\.0\.1 \(version unknown\) is not compatible with server/,
    );
  });

  it("refuses a client from an incompatible release", async () => {
    const response = await postRuns({ [VERSION_HEADER]: NEXT_MAJOR });
    assert.equal(response.status, 426);
  });

  it("lets a compatible client through to the next check, and still names its version", async () => {
    // No record key, so auth answers 401: the guard let it pass, and the
    // header is on an error built by the error handler.
    const response = await postRuns({ [VERSION_HEADER]: SERVER_VERSION });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(VERSION_HEADER), SERVER_VERSION);
  });

  it("answers /health to anyone, with its version, for clients to check first", async () => {
    const response = await server.request("/api/v1/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(VERSION_HEADER), SERVER_VERSION);
  });

  it("does not check uploads, which carry the presigned target's headers", async () => {
    const response = await server.request("/api/v1/blobs/run/attempt/trace.zip", {
      method: "PUT",
      body: "bytes",
    });
    assert.notEqual(response.status, 426);
  });
});

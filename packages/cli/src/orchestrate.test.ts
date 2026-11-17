import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { VERSION_HEADER } from "@camerihq/contract/versioning";
import { parseShard, parseSpecList, requestPlan, specFilter } from "./orchestrate.ts";
import { CLI_VERSION } from "./version.ts";

describe("parseShard", () => {
  it("reads index and total", () => {
    assert.deepEqual(parseShard("3/8"), { index: 3, total: 8 });
    assert.deepEqual(parseShard(" 1 / 2 "), { index: 1, total: 2 });
  });

  it("refuses anything that is not a shard", () => {
    for (const value of ["", "3", "3/", "/8", "a/b", "0/8", "9/8", "-1/8", "1/0"]) {
      assert.equal(parseShard(value), undefined, value);
    }
  });
});

describe("parseSpecList", () => {
  it("reads spec files out of Playwright's JSON report", () => {
    const report = JSON.stringify({
      suites: [
        {
          title: "chromium",
          suites: [{ file: "tests/b.spec.ts" }, { file: "tests/a.spec.ts" }],
        },
      ],
    });

    assert.deepEqual(parseSpecList(report), ["tests/a.spec.ts", "tests/b.spec.ts"]);
  });

  it("reads a plain list, since anything but Playwright would produce one", () => {
    assert.deepEqual(parseSpecList("tests/b.spec.ts\ntests/a.spec.ts\n"), [
      "tests/a.spec.ts",
      "tests/b.spec.ts",
    ]);
  });

  it("de-duplicates, because one file listed per project is still one file", () => {
    assert.deepEqual(parseSpecList("a.spec.ts\na.spec.ts\n"), ["a.spec.ts"]);
  });

  it("is empty for empty or unparseable input, rather than throwing", () => {
    assert.deepEqual(parseSpecList(""), []);
    assert.deepEqual(parseSpecList("   \n  "), []);
    assert.deepEqual(parseSpecList("{not json"), []);
  });
});

describe("specFilter", () => {
  it("anchors at the end so a spec cannot select its own snapshot file", () => {
    const filter = specFilter("tests/a.spec.ts");
    assert.match("tests/a.spec.ts", new RegExp(filter));
    assert.doesNotMatch("tests/a.spec.ts.snap", new RegExp(filter));
  });

  it("escapes regex metacharacters in the path", () => {
    const filter = specFilter("tests/app(v2)/a+b.spec.ts");
    assert.match("tests/app(v2)/a+b.spec.ts", new RegExp(filter));
    // Unescaped, the `.` would match any character here.
    assert.doesNotMatch("tests/app(v2)/a+bXspec.ts", new RegExp(filter));
  });
});

describe("requestPlan and version checking", () => {
  /**
   * A planner whose `/health` names `version` (or nothing), and whose plan
   * route answers with one spec. Returns `METHOD path version-header` for
   * every request it got.
   */
  async function withPlanner<T>(version: string | undefined, run: (url: string) => Promise<T>) {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers[VERSION_HEADER] ?? "-"}`);
      request.resume();
      request.on("end", () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (version !== undefined) headers[VERSION_HEADER] = version;
        const body = request.url?.endsWith("/health") ? { ok: true } : { specs: ["a.spec.ts"] };
        response.writeHead(200, headers).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return { result: await run(url), requests };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const plan = (serverUrl: string) =>
    requestPlan({
      serverUrl,
      recordKey: "cam_test",
      runKey: "run",
      shardIndex: 1,
      expectedShards: 2,
      specs: ["a.spec.ts"],
    });

  it("checks the server first, then sends its version with the plan request", async () => {
    const { result, requests } = await withPlanner(CLI_VERSION, plan);
    assert.ok(result && "plan" in result);
    assert.deepEqual(requests, ["GET /api/v1/health -", `POST /api/v1/runs/plan ${CLI_VERSION}`]);
  });

  it("falls back without asking for a plan when the server is from before versioning", async () => {
    const { result, requests } = await withPlanner(undefined, plan);
    assert.ok(result && "error" in result);
    assert.equal(result.fatal, false);
    assert.match(result.error, /server \(unknown version\) is not compatible with cli/);
    // Nothing written: the plan route was never called.
    assert.deepEqual(requests, ["GET /api/v1/health -"]);
  });
});

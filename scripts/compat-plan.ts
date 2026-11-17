/**
 * Plans the compatibility checks for this build: which published reporters
 * this server has to work with, and which published servers this reporter has
 * to work with.
 *
 *   node --import tsx scripts/compat-plan.ts              # as the next patch
 *   node --import tsx scripts/compat-plan.ts --breaking   # as the next incompatible version
 *
 * The build is checked as the version it would ship as. Normally that is the
 * next patch after the last release, so every published version it claims to
 * be compatible with is checked. A pull request labelled `breaking` ships as
 * the next incompatible version instead (a new major, or a new minor below
 * 1.0.0), and only versions compatible with that are checked.
 *
 * "Compatible" is `areVersionsCompatible`, the same rule the server and the
 * reporter use to accept each other at runtime, so the matrix is exactly the
 * set of pairs that would talk to each other in production.
 *
 * Published means what users can actually run: reporter versions on npm, and
 * server versions as image tags on GHCR.
 *
 * Prints the plan. In GitHub Actions it also writes it as step outputs
 * (`version`, `reporters`, `servers`, as JSON arrays for a matrix) and as a
 * table in the job summary.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { areVersionsCompatible, parseVersion } from "../packages/contract/src/versioning.ts";

const REPORTER_PACKAGE = "@camerihq/playwright-reporter";

const { values } = parseArgs({ options: { breaking: { type: "boolean", default: false } } });

/**
 * An exact release: a version with no pre-release part. Leaves out what moves
 * or is not a release, such as the `0.3`, `latest` and `sha-…` image tags.
 */
function isRelease(value: string): boolean {
  return parseVersion(value) !== undefined && !/[-+]/.test(value);
}

/** Ascending, by number rather than by text: 0.10.0 after 0.9.0. */
function bySemver(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/** The highest `v*` tag, the way `scripts/set-version.mjs` finds it. */
function lastRelease(): string | undefined {
  const tag = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], {
    encoding: "utf8",
  })
    .split("\n")[0]
    ?.trim();
  return tag ? tag.slice(1) : undefined;
}

/** What this build would be released as. */
function nextVersion(last: string, breaking: boolean): string {
  const version = parseVersion(last);
  if (!version) throw new Error(`the last release tag is not a version: v${last}`);
  const { major, minor, patch } = version;
  if (!breaking) return `${major}.${minor}.${patch + 1}`;
  // Incompatible by the caret rule: the leftmost non-zero part moves.
  return major > 0 ? `${major + 1}.0.0` : `0.${minor + 1}.0`;
}

function publishedReporters(): string[] {
  const out = execFileSync("npm", ["view", REPORTER_PACKAGE, "versions", "--json"], {
    encoding: "utf8",
  });
  const versions = JSON.parse(out) as string[] | string;
  return (Array.isArray(versions) ? versions : [versions]).filter(isRelease);
}

/** The repository whose GHCR images are the published servers, as `owner/name`. */
function imageRepository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const match = /github\.com[:/](.+?)(?:\.git)?\s*$/.exec(origin);
  if (!match?.[1]) throw new Error(`cannot tell the GitHub repository from origin: ${origin}`);
  return match[1].toLowerCase();
}

/** Release tags of the public server image (`ghcr.io/<repo>:<version>`). */
async function publishedServers(repository: string): Promise<string[]> {
  // Public images still want a token, but an anonymous one will do.
  const auth = await fetch(`https://ghcr.io/token?scope=repository:${repository}:pull`);
  if (!auth.ok) throw new Error(`ghcr.io token: ${auth.status}`);
  const { token } = (await auth.json()) as { token: string };

  const list = await fetch(`https://ghcr.io/v2/${repository}/tags/list?n=1000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!list.ok) throw new Error(`ghcr.io tags for ${repository}: ${list.status}`);
  const { tags } = (await list.json()) as { tags: string[] };
  return tags.filter(isRelease);
}

const last = lastRelease();
if (!last) {
  console.log("No release yet, so there is nothing to be compatible with.");
  writeOutputs({ version: "", reporters: [], servers: [] }, "");
  process.exit(0);
}

const version = nextVersion(last, values.breaking);
const repository = imageRepository();
const reporters = publishedReporters().sort(bySemver);
const servers = (await publishedServers(repository)).sort(bySemver);

// Each published version against this build, as the side it would meet.
const reporterRows = reporters.map((v) => ({
  version: v,
  checked: areVersionsCompatible({ server: version, client: v }),
}));
const serverRows = servers.map((v) => ({
  version: v,
  checked: areVersionsCompatible({ server: v, client: version }),
}));

const plan = {
  version,
  reporters: reporterRows.filter((row) => row.checked).map((row) => row.version),
  servers: serverRows.filter((row) => row.checked).map((row) => row.version),
};

const why = values.breaking
  ? `labelled \`breaking\`, so checked as the next incompatible version after ${last}`
  : `checked as the next patch after ${last}`;

const summary = [
  `### Compatibility plan for ${version}`,
  "",
  `This build is ${why}. A published version is checked when it is compatible ` +
    `with ${version} (npm \`^\` rules, the same rule the server and reporter apply at runtime).`,
  "",
  table(`Reporters (${REPORTER_PACKAGE} on npm) with this server`, reporterRows),
  "",
  table(`Servers (ghcr.io/${repository}) with this reporter`, serverRows),
].join("\n");

console.log(summary);
writeOutputs(plan, summary);

function table(title: string, rows: Array<{ version: string; checked: boolean }>): string {
  const lines = [`#### ${title}`, "", "| Version | |", "|---|---|"];
  for (const row of rows) {
    lines.push(`| ${row.version} | ${row.checked ? "checked" : `out of range for ${version}`} |`);
  }
  if (!rows.some((row) => row.checked)) {
    lines.push("", `Nothing published is compatible with ${version} yet, so nothing to check.`);
  }
  return lines.join("\n");
}

function writeOutputs(
  result: { version: string; reporters: string[]; servers: string[] },
  summaryText: string,
): void {
  const outputs = process.env.GITHUB_OUTPUT;
  if (outputs) {
    appendFileSync(
      outputs,
      `version=${result.version}\n` +
        `reporters=${JSON.stringify(result.reporters)}\n` +
        `servers=${JSON.stringify(result.servers)}\n`,
    );
  }
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary && summaryText) appendFileSync(stepSummary, `${summaryText}\n`);
}

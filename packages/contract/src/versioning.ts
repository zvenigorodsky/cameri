/**
 * Version checks between the server and its clients (the reporter and the
 * CLI). Zod-free, like `constants.ts`, so clients can bundle it.
 *
 * Each side's version is its own package version, read from its own
 * `package.json`, so a release is the only thing that changes it. Each side
 * sends it in `VERSION_HEADER`, and checks the other's with
 * `areVersionsCompatible`, so it is enforced in both directions:
 *  - the server refuses an incompatible client with 426, on every request;
 *  - a client asks `/health` before writing anything, and turns itself off
 *    against an incompatible server.
 *
 * Compatible means npm's caret (`^`) rules, the same ones a dependency range
 * follows:
 *  - from 1.0.0 on, the same major;
 *  - below that, the same minor (0.3.x);
 *  - below 0.1.0, only the exact version.
 *
 * So a release that breaks the wire is a major one, for the server and its
 * clients alike, and a release that only adds to it (an optional request field,
 * a new response field, a route the other side can live without) is a minor
 * one, which the other side must tolerate.
 */

/**
 * Sent by clients on every ingest request, with the client's package version,
 * and by the server on every response, with the server's.
 */
export const VERSION_HEADER = "x-cameri-version";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** `1.2.3`, or `1.2.3-beta.1` with the pre-release ignored. Anything else is no version. */
export function parseVersion(value: string | null | undefined): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * The part of a version that changes on a breaking release, by npm's ^ rules:
 * the leftmost non-zero part and everything before it.
 *
 *   1.4.2 → "1"      0.3.1 → "0.3"      0.0.3 → "0.0.3"
 */
function breakingPart({ major, minor, patch }: Version): string {
  if (major > 0) return `${major}`;
  if (minor > 0) return `0.${minor}`;
  return `0.0.${patch}`;
}

/** A server and a client, by version. Either may be missing: from before versioning. */
export interface VersionPair {
  server: string | null | undefined;
  client: string | null | undefined;
}

/**
 * Whether this server and this client can work together: they have the same
 * breaking part, so nothing between them is a breaking release.
 *
 * The answer is the same whichever side asks, so both sides call it the same
 * way, naming the server and the client. A missing or malformed version is
 * never compatible: it is something from before versioning, or not cameri.
 */
export function areVersionsCompatible({ server, client }: VersionPair): boolean {
  const serverVersion = parseVersion(server);
  const clientVersion = parseVersion(client);
  if (!serverVersion || !clientVersion) return false;
  return breakingPart(serverVersion) === breakingPart(clientVersion);
}

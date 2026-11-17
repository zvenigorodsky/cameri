import { CLIENT_VERSION_HEADER } from "@camerihq/contract/constants";
import {
  areVersionsCompatible,
  VERSION_HEADER,
} from "@camerihq/contract/versioning";
import type { Context, Next } from "hono";
import serverPackage from "../package.json" with { type: "json" };

/** This server's version, from its own `package.json`. */
export const SERVER_VERSION: string = serverPackage.version;

/**
 * The server's half of version checking (see `@camerihq/contract/versioning`).
 *
 * Every ingest response carries this server's version, errors included, and
 * `/health` is how a client asks before it writes anything. A client this
 * server is not compatible with is refused with 426 before it touches
 * anything, rather than half-working against rules it does not know.
 *
 * Two paths are not checked:
 *  - `/health`, so anything can ask which version this server is.
 *  - `/blobs/*`, the local stand-in for object storage. Uploads carry the
 *    headers the presigned target asked for, the same as a PUT to S3, and
 *    the signature is their authorisation.
 */
export function versionGuard() {
  return async (c: Context, next: Next) => {
    c.header(VERSION_HEADER, SERVER_VERSION);

    const exempt = c.req.path.endsWith("/health") || c.req.path.includes("/blobs/");
    const clientVersion = c.req.header(VERSION_HEADER);

    if (!exempt && !areVersionsCompatible({ server: SERVER_VERSION, client: clientVersion })) {
      const client = c.req.header(CLIENT_VERSION_HEADER) ?? "a client";
      return c.json(
        {
          error: {
            code: "version_unsupported",
            message:
              `${client} (version ${clientVersion || "unknown"}) is not compatible with server ` +
              `${SERVER_VERSION}. Use a reporter and CLI from a compatible release.`,
            details: { clientVersion: clientVersion ?? null, serverVersion: SERVER_VERSION },
          },
        },
        426,
      );
    }

    await next();
    // Again after `next`, so it lands on whatever response was built,
    // including the error handler's.
    c.res.headers.set(VERSION_HEADER, SERVER_VERSION);
  };
}

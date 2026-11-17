import cliPackage from "../package.json" with { type: "json" };

/**
 * This CLI's version, from its own `package.json`: what `--version` prints, and
 * what the server checks for compatibility (see `@camerihq/contract/versioning`).
 */
export const CLI_VERSION: string = cliPackage.version;

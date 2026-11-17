import type {
  CompleteShardRequest,
  CompleteShardResponse,
  CreateRunRequest,
  CreateRunResponse,
  ReportResultsRequest,
  ReportResultsResponse,
  ShardHeartbeatRequest,
  ShardHeartbeatResponse,
} from "@camerihq/contract";
// Values come from the zod-free entry point — see packages/contract/src/constants.ts.
import {
  CLIENT_VERSION_HEADER,
  INGEST_API_VERSION,
  RECORD_KEY_HEADER,
} from "@camerihq/contract/constants";
import {
  areVersionsCompatible,
  VERSION_HEADER,
} from "@camerihq/contract/versioning";
import reporterPackage from "../package.json" with { type: "json" };
import type { ResolvedConfig } from "./config.ts";

/** This reporter's version, from its own `package.json`. */
export const REPORTER_VERSION: string = reporterPackage.version;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's `error.message` when the body is its JSON error, else the body as is. */
function errorMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" ? message : body;
  } catch {
    return body;
  }
}

export class IngestClient {
  constructor(private readonly config: ResolvedConfig) {}

  /**
   * The reporter's half of version checking (see `@camerihq/contract/versioning`).
   *
   * Asks the server for its version before anything is written, so an
   * incompatible server is never left holding a run this reporter cannot
   * finish. A server from before versioning answers without the header, which
   * counts as incompatible. Not retryable: the reporter turns itself off once,
   * with this message, and the tests run on unreported.
   */
  async handshake(): Promise<void> {
    const response = await this.send("GET", "/health");
    const serverVersion = response.headers.get(VERSION_HEADER);
    if (areVersionsCompatible({ server: serverVersion, client: REPORTER_VERSION })) return;
    throw new IngestError(
      `server ${serverVersion || "(unknown version)"} is not compatible with reporter ` +
        `${REPORTER_VERSION}. Use a server and reporter from compatible releases.`,
      response.status,
      false,
    );
  }

  createRun(body: CreateRunRequest): Promise<CreateRunResponse> {
    return this.post<CreateRunResponse>("/runs", body);
  }

  reportResults(body: ReportResultsRequest): Promise<ReportResultsResponse> {
    return this.post<ReportResultsResponse>("/results", body);
  }

  completeShard(body: CompleteShardRequest): Promise<CompleteShardResponse> {
    return this.post<CompleteShardResponse>("/shards/complete", body);
  }

  /** No retries: the next ping is the retry, and a late ping proves nothing. */
  heartbeat(body: ShardHeartbeatRequest): Promise<ShardHeartbeatResponse> {
    return this.post<ShardHeartbeatResponse>("/shards/heartbeat", body, 0);
  }

  /**
   * Presigned upload straight to object storage — deliberately not routed
   * through the ingest API, since a trace can be hundreds of megabytes.
   */
  async upload(url: string, body: Uint8Array, headers: Record<string, string>): Promise<void> {
    const response = await fetch(url, { method: "PUT", body, headers });
    if (!response.ok) {
      throw new IngestError(`upload failed: ${response.status}`, response.status, true);
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    maxRetries = this.config.maxRetries,
  ): Promise<T> {
    const response = await this.send("POST", path, body, maxRetries);
    return (await response.json()) as T;
  }

  /** One request with retries, resolving to the first successful response. */
  private async send(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    maxRetries = this.config.maxRetries,
  ): Promise<Response> {
    const url = `${this.config.serverUrl}/api/${INGEST_API_VERSION}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so 40 shards retrying do not
        // synchronise into a thundering herd against the server.
        const backoff = Math.min(2 ** attempt * 250, 5_000);
        await sleep(backoff + Math.random() * 250);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            [RECORD_KEY_HEADER]: this.config.recordKey,
            [CLIENT_VERSION_HEADER]: `playwright-reporter/${REPORTER_VERSION}`,
            [VERSION_HEADER]: REPORTER_VERSION,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (response.ok) return response;

        const retryable = response.status >= 500 || response.status === 429;
        const detail = errorMessage(await response.text().catch(() => ""));
        lastError = new IngestError(
          `${path} → ${response.status} ${detail.slice(0, 300)}`,
          response.status,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (error) {
        if (error instanceof IngestError && !error.retryable) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new IngestError(`${path} failed after ${maxRetries} retries`);
  }
}

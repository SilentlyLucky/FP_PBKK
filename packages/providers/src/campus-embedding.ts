import { z } from "zod";

import { ProviderRequestError } from "./campus.js";

export const DEFAULT_CAMPUS_EMBEDDING_TIMEOUT_MS = 60_000;
export const MAX_CAMPUS_EMBEDDING_TIMEOUT_MS = 150_000;
export const CAMPUS_EMBEDDING_DIMENSIONS = 768;

const EmbeddingResponseSchema = z.object({
  model: z.string().optional(),
  data: z.array(
    z.object({
      index: z.number().int().nonnegative().optional(),
      embedding: z.array(z.number().finite()),
    }),
  ),
});

export interface CampusEmbeddingProviderConfig {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly requestedModel: string;
  readonly timeoutMs?: number;
  readonly dimensions?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface CampusEmbeddingResult {
  readonly requestedModel: string;
  readonly responseModel: string | null;
  readonly dimensions: number;
  readonly vector: readonly number[];
}

export interface CampusEmbeddingEnvironmentConfiguration {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly requestedModel: string;
  readonly timeoutMs: number;
}

function validEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    if (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export function campusEmbeddingTimeoutMsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PROMPTLAB_CAMPUS_EMBEDDING_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CAMPUS_EMBEDDING_TIMEOUT_MS;
  const timeoutMs = Number(raw);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAX_CAMPUS_EMBEDDING_TIMEOUT_MS
  ) {
    throw new Error("CAMPUS_EMBEDDING_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

export function campusEmbeddingConfigurationFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CampusEmbeddingEnvironmentConfiguration | null {
  const apiKey = env.PROMPTLAB_CAMPUS_API_KEY?.trim();
  const endpointValue = env.PROMPTLAB_CAMPUS_EMBEDDING_ENDPOINT?.trim();
  const requestedModel = env.PROMPTLAB_CAMPUS_EMBEDDING_MODEL?.trim();
  if (!apiKey || !endpointValue || !requestedModel) return null;
  const endpoint = validEndpoint(endpointValue);
  if (!endpoint) throw new Error("CAMPUS_EMBEDDING_ENDPOINT_INVALID");
  return {
    apiKey,
    endpoint,
    requestedModel,
    timeoutMs: campusEmbeddingTimeoutMsFromEnvironment(env),
  };
}

/** Calls one explicitly configured embedding endpoint and never retries. */
export class CampusEmbeddingProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly dimensions: number;
  private readonly endpoint: string;

  constructor(private readonly config: CampusEmbeddingProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new ProviderRequestError(
        "AUTH_REQUIRED",
        "Campus gateway credential is not configured",
      );
    }
    const endpoint = validEndpoint(config.endpoint.trim());
    if (!endpoint) throw new Error("CAMPUS_EMBEDDING_ENDPOINT_INVALID");
    if (!config.requestedModel.trim()) {
      throw new Error("CAMPUS_EMBEDDING_MODEL_INVALID");
    }
    this.endpoint = endpoint;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_CAMPUS_EMBEDDING_TIMEOUT_MS;
    this.dimensions = config.dimensions ?? CAMPUS_EMBEDDING_DIMENSIONS;
    if (!Number.isSafeInteger(this.dimensions) || this.dimensions < 1) {
      throw new Error("CAMPUS_EMBEDDING_DIMENSIONS_INVALID");
    }
  }

  async embed(
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CampusEmbeddingResult> {
    if (!text.trim()) {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Embedding input must not be empty",
      );
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: this.config.requestedModel,
          input: text,
        }),
      });
    } catch {
      if (options.signal?.aborted) {
        throw new ProviderRequestError(
          "PROVIDER_ABORTED",
          "Embedding request was canceled",
        );
      }
      if (signal.aborted) {
        throw new ProviderRequestError(
          "PROVIDER_TIMEOUT",
          "Embedding request timed out",
          true,
        );
      }
      throw new ProviderRequestError(
        "PROVIDER_HTTP_ERROR",
        "Campus embedding request failed",
        true,
      );
    }
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      throw new ProviderRequestError(
        response.status === 401 || response.status === 403
          ? "AUTH_REQUIRED"
          : "PROVIDER_HTTP_ERROR",
        `Campus embedding endpoint returned HTTP ${response.status}`,
        retryable,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus embedding endpoint returned invalid JSON",
      );
    }
    const parsed = EmbeddingResponseSchema.safeParse(json);
    const item = parsed.success ? parsed.data.data[0] : undefined;
    if (
      !parsed.success ||
      parsed.data.data.length !== 1 ||
      !item ||
      (item.index !== undefined && item.index !== 0) ||
      item.embedding.length !== this.dimensions
    ) {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus embedding response did not match the configured vector profile",
      );
    }
    const norm = Math.hypot(...item.embedding);
    if (!Number.isFinite(norm) || norm === 0) {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus embedding response contained a zero or invalid vector",
      );
    }
    return {
      requestedModel: this.config.requestedModel,
      responseModel: parsed.data.model ?? null,
      dimensions: this.dimensions,
      vector: item.embedding,
    };
  }
}

export function campusEmbeddingProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { provider: CampusEmbeddingProvider; requestedModel: string } | null {
  const configuration = campusEmbeddingConfigurationFromEnvironment(env);
  if (!configuration) return null;
  return {
    provider: new CampusEmbeddingProvider(configuration),
    requestedModel: configuration.requestedModel,
  };
}

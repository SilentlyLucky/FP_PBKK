import {
  ChatCompletionRequestSchema,
  ProviderCompletionSchema,
  type ChatCompletionRequestInput,
  type ProviderCompletion,
} from "@promptlab/contracts";
import { z } from "zod";

export const CAMPUS_CHAT_COMPLETIONS_ENDPOINT =
  "https://senopati.its.ac.id/llm-gateway/v1/chat/completions" as const;

export const DEFAULT_CAMPUS_OPTIMIZER_TIMEOUT_MS = 90_000;
export const MAX_CAMPUS_OPTIMIZER_TIMEOUT_MS = 150_000;

export function campusOptimizerTimeoutMsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CAMPUS_OPTIMIZER_TIMEOUT_MS;

  const timeoutMs = Number(raw);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAX_CAMPUS_OPTIMIZER_TIMEOUT_MS
  ) {
    throw new Error("CAMPUS_OPTIMIZER_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

const CampusResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      message: z.object({
        content: z
          .union([z.string(), z.array(z.unknown())])
          .nullable()
          .optional(),
        tool_calls: z
          .array(
            z.object({
              type: z.string().optional(),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            }),
          )
          .optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .optional(),
      completion_tokens_details: z
        .object({
          cache_write_tokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

const CampusStreamChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().nullable().optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: CampusResponseSchema.shape.usage,
});

const CAPABILITY_OUTPUT_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "promptlab_capability_probe",
    strict: true,
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
} as const;

export interface CampusCapabilityStreamResult {
  text: string;
  responseModel: string | null;
  textDeltaObserved: boolean;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface CampusRequestDiagnostics {
  phase: "request_headers" | "response_headers" | "response_body";
  elapsedMs: number;
  responseStatus?: number;
  transportCode?: CampusTransportErrorCode;
  responseHeadersMs?: number;
  firstChunkMs?: number | null;
  finishReasonSeen?: boolean;
  doneMarkerSeen?: boolean;
  outputTruncated?: boolean;
  outputEmpty?: boolean;
}

type CampusTransportErrorCode =
  | "ECONNRESET"
  | "ECONNREFUSED"
  | "ENOTFOUND"
  | "EAI_AGAIN"
  | "ETIMEDOUT"
  | "UND_ERR_CONNECT_TIMEOUT"
  | "UND_ERR_HEADERS_TIMEOUT"
  | "UND_ERR_SOCKET"
  | "OTHER";

const campusTransportErrorCodes = new Set<CampusTransportErrorCode>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface CampusProviderConfig {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  /** Disable model reasoning when the caller needs a short structured response. */
  readonly disableThinking?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface CampusEnvironmentConfiguration {
  readonly apiKey: string;
  readonly requestedModel: string;
  readonly timeoutMs: number;
}

export class ProviderRequestError extends Error {
  constructor(
    readonly code:
      | "AUTH_REQUIRED"
      | "PROVIDER_HTTP_ERROR"
      | "PROVIDER_TRANSPORT_ERROR"
      | "PROVIDER_RESPONSE_INVALID"
      | "PROVIDER_TIMEOUT"
      | "PROVIDER_ABORTED",
    message: string,
    readonly retryable = false,
    readonly diagnostics?: CampusRequestDiagnostics,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** Calls only the authorized campus endpoint. It never retries or falls back. */
export class CampusChatProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly thinkingOption: { readonly think?: false };

  constructor(private readonly config: CampusProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new ProviderRequestError(
        "AUTH_REQUIRED",
        "Campus gateway credential is not configured",
      );
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.thinkingOption = config.disableThinking ? { think: false } : {};
  }

  async complete(
    rawRequest: ChatCompletionRequestInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ProviderCompletion> {
    const request = ChatCompletionRequestSchema.parse(rawRequest);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const requestStartedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetchImpl(CAMPUS_CHAT_COMPLETIONS_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          stream: false,
          ...this.thinkingOption,
        }),
      });
    } catch (error) {
      throw requestFailure(options.signal, signal, {
        phase: "request_headers",
        elapsedMs: elapsedMs(requestStartedAt),
        transportCode: safeTransportErrorCode(error),
      });
    }

    const responseHeadersMs = elapsedMs(requestStartedAt);
    const responseDiagnostics: CampusRequestDiagnostics = {
      phase: "response_body",
      elapsedMs: responseHeadersMs,
      responseStatus: response.status,
      responseHeadersMs,
    };
    if (!response.ok) {
      throw httpFailure(response.status, {
        ...responseDiagnostics,
        phase: "response_headers",
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      const diagnostics = {
        ...responseDiagnostics,
        elapsedMs: elapsedMs(requestStartedAt),
      };
      if (options.signal?.aborted || signal.aborted) {
        throw requestFailure(options.signal, signal, diagnostics);
      }
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus gateway returned invalid JSON",
        false,
        diagnostics,
      );
    }

    const parsed = CampusResponseSchema.safeParse(json);
    const choice = parsed.success ? parsed.data.choices[0] : undefined;
    const content = choice?.message.content;
    const completedDiagnostics = {
      ...responseDiagnostics,
      elapsedMs: elapsedMs(requestStartedAt),
    };
    if (!parsed.success || typeof content !== "string") {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus gateway response did not match the expected chat completion shape",
        false,
        completedDiagnostics,
      );
    }
    if (choice?.finish_reason === "length") {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus gateway response was truncated at the output token limit",
        false,
        { ...completedDiagnostics, outputTruncated: true },
      );
    }
    if (!content.trim()) {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus gateway returned no visible response text",
        false,
        { ...completedDiagnostics, outputEmpty: true },
      );
    }

    const now = new Date().toISOString();
    const usage = parsed.data.usage;
    const cacheRead = usage?.prompt_tokens_details?.cached_tokens;
    const cacheWrite = usage?.completion_tokens_details?.cache_write_tokens;
    const usagePresent =
      usage?.prompt_tokens !== undefined &&
      usage.completion_tokens !== undefined;
    const completion: ProviderCompletion = {
      provider: "campus_gateway",
      requestedModel: request.model,
      responseModel: parsed.data.model ?? null,
      responseId: parsed.data.id ?? null,
      text: content,
      observedAt: now,
      usage: {
        inputTokens:
          usage?.prompt_tokens === undefined
            ? {
                status: "unknown",
                value: null,
                reason: "Gateway tidak melaporkan prompt_tokens",
              }
            : {
                status: "reported",
                value: usage.prompt_tokens,
                observedAt: now,
                method: "OpenAI-compatible usage.prompt_tokens",
              },
        outputTokens:
          usage?.completion_tokens === undefined
            ? {
                status: "unknown",
                value: null,
                reason: "Gateway tidak melaporkan completion_tokens",
              }
            : {
                status: "reported",
                value: usage.completion_tokens,
                observedAt: now,
                method: "OpenAI-compatible usage.completion_tokens",
              },
        cacheReadTokens:
          cacheRead === undefined
            ? {
                status: "unknown",
                value: null,
                reason: "Gateway tidak melaporkan cache read tokens",
              }
            : {
                status: "reported",
                value: cacheRead,
                observedAt: now,
                method: "usage.prompt_tokens_details.cached_tokens",
              },
        cacheWriteTokens:
          cacheWrite === undefined
            ? {
                status: "unknown",
                value: null,
                reason: "Gateway tidak melaporkan cache write tokens",
              }
            : {
                status: "reported",
                value: cacheWrite,
                observedAt: now,
                method: "usage.completion_tokens_details.cache_write_tokens",
              },
        completeness: usagePresent
          ? cacheRead === undefined || cacheWrite === undefined
            ? "partial"
            : "complete"
          : "unknown",
        responseId: parsed.data.id ?? null,
        mapperVersion: "campus-openai-compatible-v1",
      },
    };

    return ProviderCompletionSchema.parse(completion);
  }

  /** Runs a bounded streaming JSON-schema probe and records no response text. */
  async streamCapabilityProbe(
    rawRequest: ChatCompletionRequestInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CampusCapabilityStreamResult> {
    const request = ChatCompletionRequestSchema.parse(rawRequest);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const requestStartedAt = performance.now();
    let response: Response;
    let responseHeadersMs: number;
    try {
      response = await this.fetchImpl(CAMPUS_CHAT_COMPLETIONS_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
          response_format: CAPABILITY_OUTPUT_SCHEMA,
          ...this.thinkingOption,
        }),
      });
      responseHeadersMs = elapsedMs(requestStartedAt);
    } catch (error) {
      throw requestFailure(options.signal, signal, {
        phase: "request_headers",
        elapsedMs: elapsedMs(requestStartedAt),
        transportCode: safeTransportErrorCode(error),
      });
    }
    if (!response.ok) throw httpFailure(response.status);
    if (!response.body) {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus gateway returned no streaming response body",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const usage: CampusCapabilityStreamResult["usage"] = {};
    let text = "";
    let responseModel: string | null = null;
    let textDeltaObserved = false;
    let buffer = "";
    const diagnostics: CampusRequestDiagnostics = {
      phase: "response_body",
      elapsedMs: 0,
      responseStatus: response.status,
      responseHeadersMs,
      firstChunkMs: null,
      finishReasonSeen: false,
      doneMarkerSeen: false,
    };
    const consumeLine = (rawLine: string) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith("data:")) return false;
      const payload = line.slice(5).trimStart();
      if (payload === "[DONE]") {
        diagnostics.doneMarkerSeen = true;
        return true;
      }
      if (!payload) return false;
      let value: unknown;
      try {
        value = JSON.parse(payload) as unknown;
      } catch {
        throw new ProviderRequestError(
          "PROVIDER_RESPONSE_INVALID",
          "Campus gateway returned an invalid streaming event",
        );
      }
      const parsed = CampusStreamChunkSchema.safeParse(value);
      if (!parsed.success) {
        throw new ProviderRequestError(
          "PROVIDER_RESPONSE_INVALID",
          "Campus gateway returned an unknown streaming event shape",
        );
      }
      responseModel ??= parsed.data.model ?? null;
      if (
        parsed.data.choices.some(
          (choice) =>
            choice.finish_reason !== undefined && choice.finish_reason !== null,
        )
      ) {
        diagnostics.finishReasonSeen = true;
      }
      const delta = parsed.data.choices[0]?.delta.content;
      if (typeof delta === "string" && delta.length > 0) {
        textDeltaObserved = true;
        text += delta;
      }
      const reportedUsage = parsed.data.usage;
      if (reportedUsage?.prompt_tokens !== undefined)
        usage.inputTokens = reportedUsage.prompt_tokens;
      if (reportedUsage?.completion_tokens !== undefined)
        usage.outputTokens = reportedUsage.completion_tokens;
      if (reportedUsage?.prompt_tokens_details?.cached_tokens !== undefined)
        usage.cacheReadTokens =
          reportedUsage.prompt_tokens_details.cached_tokens;
      if (
        reportedUsage?.completion_tokens_details?.cache_write_tokens !==
        undefined
      )
        usage.cacheWriteTokens =
          reportedUsage.completion_tokens_details.cache_write_tokens;
      return false;
    };

    try {
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (
          value &&
          value.byteLength > 0 &&
          diagnostics.firstChunkMs === null
        ) {
          diagnostics.firstChunkMs = elapsedMs(requestStartedAt);
        }
        buffer += decoder.decode(value, { stream: !streamDone });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (consumeLine(line)) {
            done = true;
            break;
          }
        }
        if (streamDone) {
          if (buffer && consumeLine(buffer)) done = true;
          break;
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      diagnostics.elapsedMs = elapsedMs(requestStartedAt);
      if (error instanceof ProviderRequestError) {
        throw new ProviderRequestError(
          error.code,
          error.message,
          error.retryable,
          diagnostics,
        );
      }
      throw requestFailure(options.signal, signal, {
        ...diagnostics,
        transportCode: safeTransportErrorCode(error),
      });
    } finally {
      reader.releaseLock();
    }

    return { text, responseModel, textDeltaObserved, usage };
  }

  /** Requests one forced function call; the function is observed, never run. */
  async probeToolCall(
    rawRequest: ChatCompletionRequestInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const request = ChatCompletionRequestSchema.parse(rawRequest);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(CAMPUS_CHAT_COMPLETIONS_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          stream: false,
          ...this.thinkingOption,
          tools: [
            {
              type: "function",
              function: {
                name: "promptlab_capability_probe",
                description: "Return the fixed verification marker.",
                strict: true,
                parameters: {
                  type: "object",
                  properties: {
                    confirmation: {
                      type: "string",
                      enum: ["PROMPTLAB TOOL CALL READY"],
                    },
                  },
                  required: ["confirmation"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: "promptlab_capability_probe" },
          },
        }),
      });
    } catch {
      throw requestFailure(options.signal, signal);
    }
    if (!response.ok) throw httpFailure(response.status);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderRequestError(
        "PROVIDER_RESPONSE_INVALID",
        "Campus gateway returned invalid JSON",
      );
    }
    const parsed = CampusResponseSchema.safeParse(json);
    const toolCalls = parsed.success
      ? (parsed.data.choices[0]?.message.tool_calls ?? [])
      : [];
    return toolCalls.some((toolCall) => {
      if (toolCall.function.name !== "promptlab_capability_probe") return false;
      try {
        const args = JSON.parse(toolCall.function.arguments) as unknown;
        return (
          typeof args === "object" &&
          args !== null &&
          !Array.isArray(args) &&
          "confirmation" in args &&
          args.confirmation === "PROMPTLAB TOOL CALL READY"
        );
      } catch {
        return false;
      }
    });
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeTransportErrorCode(error: unknown): CampusTransportErrorCode {
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? error.cause
      : error;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined;
  return typeof code === "string" &&
    campusTransportErrorCodes.has(code as CampusTransportErrorCode)
    ? (code as CampusTransportErrorCode)
    : "OTHER";
}

function requestFailure(
  callerSignal: AbortSignal | undefined,
  combinedSignal: AbortSignal,
  diagnostics?: CampusRequestDiagnostics,
): ProviderRequestError {
  if (callerSignal?.aborted) {
    return new ProviderRequestError(
      "PROVIDER_ABORTED",
      "Provider request was canceled",
      false,
      diagnostics,
    );
  }
  if (combinedSignal.aborted) {
    return new ProviderRequestError(
      "PROVIDER_TIMEOUT",
      "Provider request timed out",
      false,
      diagnostics,
    );
  }
  return new ProviderRequestError(
    "PROVIDER_TRANSPORT_ERROR",
    "Campus gateway transport failed before a usable response was received",
    false,
    diagnostics,
  );
}

function httpFailure(
  status: number,
  diagnostics?: CampusRequestDiagnostics,
): ProviderRequestError {
  return new ProviderRequestError(
    status === 401 || status === 403 ? "AUTH_REQUIRED" : "PROVIDER_HTTP_ERROR",
    `Campus gateway returned HTTP ${status}`,
    false,
    diagnostics,
  );
}

export function campusProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { provider: CampusChatProvider; requestedModel: string } | null {
  const configuration = campusConfigurationFromEnvironment(env);
  if (!configuration) return null;
  const { requestedModel, ...providerConfig } = configuration;
  return {
    provider: new CampusChatProvider(providerConfig),
    requestedModel,
  };
}

export function campusConfigurationFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CampusEnvironmentConfiguration | null {
  const apiKey = env.PROMPTLAB_CAMPUS_API_KEY?.trim();
  const requestedModel = env.PROMPTLAB_CAMPUS_MODEL?.trim();
  if (!apiKey || !requestedModel) return null;
  return {
    apiKey,
    requestedModel,
    timeoutMs: campusOptimizerTimeoutMsFromEnvironment(env),
  };
}

import { describe, expect, it, vi } from "vitest";

import {
  CAMPUS_CHAT_COMPLETIONS_ENDPOINT,
  CampusChatProvider,
  ProviderRequestError,
  campusConfigurationFromEnvironment,
  campusProviderFromEnvironment,
  campusOptimizerTimeoutMsFromEnvironment,
} from "./campus.js";

const request = {
  model: "qwen3:14b",
  purpose: "optimizer" as const,
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("campus chat provider", () => {
  it("uses only the authorized endpoint, sends one request, and maps missing metrics as unknown", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: "response-1",
            model: "campus-qwen-alias",
            choices: [{ message: { content: "ready" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      fetchImpl,
    });

    const result = await provider.complete(request);
    const [url, init] = fetchImpl.mock.calls[0]!;

    expect(url).toBe(CAMPUS_CHAT_COMPLETIONS_ENDPOINT);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-only-secret",
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("think");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.responseModel).toBe("campus-qwen-alias");
    expect(result.usage.inputTokens).toMatchObject({
      status: "reported",
      value: 4,
    });
    expect(result.usage.cacheReadTokens.status).toBe("unknown");
    expect(result.usage.completeness).toBe("partial");
  });

  it("sends think:false only when a bounded completion probe opts in", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: "campus-qwen-alias",
            choices: [{ message: { content: "ready" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      disableThinking: true,
      fetchImpl,
    });

    await provider.complete(request);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ think: false });
  });

  it("applies the opt-in think:false setting to bounded streaming and tool probes", async () => {
    const streamEvent = `data: ${JSON.stringify({
      model: "campus-qwen-alias",
      choices: [
        {
          delta: { content: '{"answer":"ready"}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`;
    const streamFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(streamEvent, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const streamProvider = new CampusChatProvider({
      apiKey: "test-only-secret",
      disableThinking: true,
      fetchImpl: streamFetch,
    });
    const streamResult = await streamProvider.streamCapabilityProbe(request);
    const [, streamInit] = streamFetch.mock.calls[0]!;

    expect(streamResult.text).toBe('{"answer":"ready"}');
    expect(JSON.parse(String(streamInit?.body))).toMatchObject({
      think: false,
    });

    const toolFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: "campus-qwen-alias",
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      type: "function",
                      function: {
                        name: "promptlab_capability_probe",
                        arguments:
                          '{"confirmation":"PROMPTLAB TOOL CALL READY"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const toolProvider = new CampusChatProvider({
      apiKey: "test-only-secret",
      disableThinking: true,
      fetchImpl: toolFetch,
    });

    await expect(toolProvider.probeToolCall(request)).resolves.toBe(true);

    const [, toolInit] = toolFetch.mock.calls[0]!;
    expect(JSON.parse(String(toolInit?.body))).toMatchObject({
      think: false,
    });
  });

  it("does not create a campus provider without both credential and confirmed model", () => {
    expect(campusProviderFromEnvironment({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      campusProviderFromEnvironment({
        PROMPTLAB_CAMPUS_API_KEY: "x",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("maps invalid credentials safely and makes no retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("authorization=should-not-leak", { status: 401 }),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      fetchImpl,
    });

    let failure: unknown;
    try {
      await provider.complete(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ProviderRequestError",
      code: "AUTH_REQUIRED",
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("test-only-secret");
    expect((failure as Error).message).not.toContain("should-not-leak");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a transport failure from an HTTP response without leaking details", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed", {
        cause: { code: "ECONNRESET", message: "private detail" },
      });
    });
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      fetchImpl,
    });

    let failure: unknown;
    try {
      await provider.complete(request);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PROVIDER_TRANSPORT_ERROR",
      diagnostics: {
        phase: "request_headers",
        elapsedMs: expect.any(Number),
        transportCode: "ECONNRESET",
      },
    });
    expect((failure as Error).message).not.toContain("fetch failed");
    expect((failure as Error).message).not.toContain("private detail");
    expect((failure as Error).message).not.toContain("test-only-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves upstream HTTP status and elapsed time without exposing the response body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("private gateway diagnostic", { status: 504 }),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      fetchImpl,
    });

    let failure: unknown;
    try {
      await provider.complete(request);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PROVIDER_HTTP_ERROR",
      message: "Campus gateway returned HTTP 504",
      diagnostics: {
        phase: "response_headers",
        responseStatus: 504,
        elapsedMs: expect.any(Number),
        responseHeadersMs: expect.any(Number),
      },
    });
    expect((failure as Error).message).not.toContain(
      "private gateway diagnostic",
    );
    expect((failure as Error).message).not.toContain("test-only-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["", "  \n  "])(
    "rejects a successful response with blank visible content (%j)",
    async (content) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen3:14b",
              choices: [{ message: { content }, finish_reason: "stop" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const provider = new CampusChatProvider({
        apiKey: "test-only-secret",
        fetchImpl,
      });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: "PROVIDER_RESPONSE_INVALID",
        diagnostics: {
          responseStatus: 200,
          elapsedMs: expect.any(Number),
          outputEmpty: true,
        },
      });
    },
  );

  it("rejects output truncated by the provider token limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: "qwen3:14b",
            choices: [
              { message: { content: '{"answer":' }, finish_reason: "length" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      fetchImpl,
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      message:
        "Campus gateway response was truncated at the output token limit",
      diagnostics: {
        responseStatus: 200,
        elapsedMs: expect.any(Number),
        outputTruncated: true,
      },
    });
  });

  it("rejects blank credentials before making a request", () => {
    expect(() => new CampusChatProvider({ apiKey: "  " })).toThrow(
      ProviderRequestError,
    );
  });

  it("uses a longer configurable timeout for optimizer requests", () => {
    expect(
      campusOptimizerTimeoutMsFromEnvironment({} as NodeJS.ProcessEnv),
    ).toBe(90_000);
    expect(
      campusOptimizerTimeoutMsFromEnvironment({
        PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS: "120000",
      } as NodeJS.ProcessEnv),
    ).toBe(120_000);
    expect(() =>
      campusOptimizerTimeoutMsFromEnvironment({
        PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS: "150001",
      } as NodeJS.ProcessEnv),
    ).toThrow("CAMPUS_OPTIMIZER_TIMEOUT_INVALID");
  });

  it("passes the configured timeout through the worker provider factory", () => {
    expect(
      campusConfigurationFromEnvironment({
        PROMPTLAB_CAMPUS_API_KEY: "test-only-secret",
        PROMPTLAB_CAMPUS_MODEL: "qwen3:14b",
        PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS: "120000",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      apiKey: "test-only-secret",
      requestedModel: "qwen3:14b",
      timeoutMs: 120_000,
    });
  });

  it("times out a pending request at the configured limit without retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("Expected request signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        }),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      timeoutMs: 10,
      fetchImpl,
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      diagnostics: {
        phase: "request_headers",
        elapsedMs: expect.any(Number),
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records whether a streaming timeout happened before response headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("Expected request signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      timeoutMs: 15,
      fetchImpl,
    });

    await expect(provider.streamCapabilityProbe(request)).rejects.toMatchObject(
      {
        code: "PROVIDER_TIMEOUT",
        diagnostics: {
          phase: "request_headers",
          elapsedMs: expect.any(Number),
        },
      },
    );
  });

  it("records a finished stream choice when the gateway never terminates the SSE body", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"model":"qwen3:14b","choices":[{"delta":{"content":"{\\"answer\\":\\"ok\\"}"},"finish_reason":"stop"}]}\n\n',
              ),
            );
            if (signal instanceof AbortSignal) {
              signal.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      timeoutMs: 15,
      fetchImpl,
    });

    await expect(provider.streamCapabilityProbe(request)).rejects.toMatchObject(
      {
        code: "PROVIDER_TIMEOUT",
        diagnostics: {
          phase: "response_body",
          responseStatus: 200,
          responseHeadersMs: expect.any(Number),
          firstChunkMs: expect.any(Number),
          finishReasonSeen: true,
          doneMarkerSeen: false,
        },
      },
    );
  });

  it("preserves cancellation when the configured provider timeout is longer", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("Expected request signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        }),
    );
    const provider = new CampusChatProvider({
      apiKey: "test-only-secret",
      timeoutMs: 60_000,
      fetchImpl,
    });

    const pending = provider.complete(request, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

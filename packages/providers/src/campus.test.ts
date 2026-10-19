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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.responseModel).toBe("campus-qwen-alias");
    expect(result.usage.inputTokens).toMatchObject({
      status: "reported",
      value: 4,
    });
    expect(result.usage.cacheReadTokens.status).toBe("unknown");
    expect(result.usage.completeness).toBe("partial");
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
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

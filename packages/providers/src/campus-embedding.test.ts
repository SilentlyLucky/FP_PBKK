import { describe, expect, it, vi } from "vitest";

import {
  CAMPUS_EMBEDDING_DIMENSIONS,
  CampusEmbeddingProvider,
  campusEmbeddingConfigurationFromEnvironment,
  campusEmbeddingProviderFromEnvironment,
  campusEmbeddingTimeoutMsFromEnvironment,
} from "./campus-embedding.js";

const vector = Array.from(
  { length: CAMPUS_EMBEDDING_DIMENSIONS },
  (_, index) => (index === 0 ? 1 : 0),
);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Campus embedding provider", () => {
  it("sends one OpenAI-compatible request to the configured endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({
        model: "embeddinggemma:latest",
        data: [{ index: 0, embedding: vector }],
      }),
    );
    const provider = new CampusEmbeddingProvider({
      apiKey: "test-only-secret",
      endpoint: "https://campus.example/v1/embeddings",
      requestedModel: "embeddinggemma:latest",
      fetchImpl,
    });

    const result = await provider.embed("2 + 2 = 5");
    const [url, init] = fetchImpl.mock.calls[0]!;

    expect(url).toBe("https://campus.example/v1/embeddings");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-only-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "embeddinggemma:latest",
      input: "2 + 2 = 5",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      requestedModel: "embeddinggemma:latest",
      responseModel: "embeddinggemma:latest",
      dimensions: 768,
      vector,
    });
  });

  it("requires an explicit endpoint and model in environment configuration", () => {
    expect(
      campusEmbeddingProviderFromEnvironment({
        PROMPTLAB_CAMPUS_API_KEY: "test-only-secret",
        PROMPTLAB_CAMPUS_EMBEDDING_MODEL: "embeddinggemma:latest",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      campusEmbeddingConfigurationFromEnvironment({
        PROMPTLAB_CAMPUS_API_KEY: "test-only-secret",
        PROMPTLAB_CAMPUS_EMBEDDING_ENDPOINT:
          "https://campus.example/v1/embeddings",
        PROMPTLAB_CAMPUS_EMBEDDING_MODEL: "embeddinggemma:latest",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      endpoint: "https://campus.example/v1/embeddings",
      requestedModel: "embeddinggemma:latest",
    });
  });

  it("rejects non-HTTPS endpoints except loopback test/local endpoints", () => {
    expect(
      () =>
        new CampusEmbeddingProvider({
          apiKey: "test-only-secret",
          endpoint: "http://campus.example/embeddings",
          requestedModel: "embeddinggemma:latest",
        }),
    ).toThrow("CAMPUS_EMBEDDING_ENDPOINT_INVALID");
    expect(
      campusEmbeddingConfigurationFromEnvironment({
        PROMPTLAB_CAMPUS_API_KEY: "test-only-secret",
        PROMPTLAB_CAMPUS_EMBEDDING_ENDPOINT: "http://127.0.0.1:11434/api/embed",
        PROMPTLAB_CAMPUS_EMBEDDING_MODEL: "embeddinggemma:latest",
      } as NodeJS.ProcessEnv),
    ).not.toBeNull();
  });

  it.each([
    ["wrong dimensions", { data: [{ embedding: [1, 2, 3] }] }],
    ["zero vector", { data: [{ embedding: Array(768).fill(0) }] }],
    [
      "non-finite vector",
      { data: [{ embedding: [null, ...Array(767).fill(0)] }] },
    ],
    [
      "multiple vectors",
      { data: [{ embedding: vector }, { embedding: vector }] },
    ],
  ])("rejects a malformed response (%s)", async (_label, body) => {
    const provider = new CampusEmbeddingProvider({
      apiKey: "test-only-secret",
      endpoint: "https://campus.example/v1/embeddings",
      requestedModel: "embeddinggemma:latest",
      fetchImpl: vi.fn<typeof fetch>(async () => response(body)),
    });

    await expect(provider.embed("input")).rejects.toMatchObject({
      name: "ProviderRequestError",
      code: "PROVIDER_RESPONSE_INVALID",
    });
  });

  it("marks authentication failures as permanent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ error: "private provider detail" }, 401),
    );
    const provider = new CampusEmbeddingProvider({
      apiKey: "test-only-secret",
      endpoint: "https://campus.example/v1/embeddings",
      requestedModel: "embeddinggemma:latest",
      fetchImpl,
    });

    await expect(provider.embed("input")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, false],
    [429, true],
    [503, true],
  ])("classifies HTTP %i as retryable=%s", async (status, retryable) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ error: "redacted provider error" }, status),
    );
    const provider = new CampusEmbeddingProvider({
      apiKey: "test-only-secret",
      endpoint: "https://campus.example/v1/embeddings",
      requestedModel: "embeddinggemma:latest",
      fetchImpl,
    });

    await expect(provider.embed("input")).rejects.toMatchObject({
      code: "PROVIDER_HTTP_ERROR",
      retryable,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the bounded embedding timeout setting", () => {
    expect(
      campusEmbeddingTimeoutMsFromEnvironment({} as NodeJS.ProcessEnv),
    ).toBe(60_000);
    expect(
      campusEmbeddingTimeoutMsFromEnvironment({
        PROMPTLAB_CAMPUS_EMBEDDING_TIMEOUT_MS: "120000",
      } as NodeJS.ProcessEnv),
    ).toBe(120_000);
    expect(() =>
      campusEmbeddingTimeoutMsFromEnvironment({
        PROMPTLAB_CAMPUS_EMBEDDING_TIMEOUT_MS: "150001",
      } as NodeJS.ProcessEnv),
    ).toThrow("CAMPUS_EMBEDDING_TIMEOUT_INVALID");
  });

  it("marks timeouts as retryable without retrying inside the provider", async () => {
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
    const provider = new CampusEmbeddingProvider({
      apiKey: "test-only-secret",
      endpoint: "https://campus.example/v1/embeddings",
      requestedModel: "embeddinggemma:latest",
      timeoutMs: 10,
      fetchImpl,
    });

    await expect(provider.embed("input")).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  CODEX_APP_SERVER_ARGS,
  CODEX_CLI_VERSION,
  CODEX_ISOLATION_POLICY_VERSION,
  CodexAppServerSession,
  codexAccountFingerprintFromSnapshot,
  codexEffectiveTargetPolicy,
  codexConfigurationFingerprint,
  codexVerificationMatchesConfiguration,
  codexVerificationReceipt,
  codexTargetPolicyFingerprint,
  executeCodexTurn,
  isOfficialCodexLoginUrl,
  type CodexAccountSnapshot,
  type CodexNotificationHandler,
} from "./app-server.js";
import { CodexTurnProtocolGuard } from "./restrictions.js";

const MODEL_ID = "codex-test-model";
const CODEX_HOME_FINGERPRINT = "a".repeat(64);
const RESTRICTED_RUNTIME_CONFIG = {
  features: {
    shell_tool: false,
    unified_exec: false,
    multi_agent: false,
    apps: false,
  },
  web_search: "disabled",
  project_doc_max_bytes: 0,
  mcp_servers: {},
  approval_policy: "never",
  sandbox_mode: "read-only",
};

class MockCodexSession {
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  private readonly handlers = new Set<CodexNotificationHandler>();

  constructor(
    private readonly options: {
      accountEmail?: string;
      models?: string[];
      reasoningEfforts?: string[];
      runtimeConfig?: Record<string, unknown>;
      threadStartResponse?: Record<string, unknown>;
      beforeRequest?: (method: string) => Promise<void>;
      turnStartBehavior?: (
        threadId: string,
        emit: (message: {
          method: string;
          params: Record<string, unknown>;
        }) => void,
      ) => Promise<Record<string, unknown>>;
    } = {},
  ) {}

  readonly serverResponses: Array<{
    id: number | string;
    response:
      { result: unknown } | { error: { code: number; message: string } };
  }> = [];

  onNotification(handler: CodexNotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.requests.push({ method, params });
    await this.options.beforeRequest?.(method);

    let response: unknown;
    if (method === "account/read") {
      response = {
        account: {
          type: "chatgpt",
          email: this.options.accountEmail ?? "codex-user@example.com",
          planType: "plus",
        },
      };
    } else if (method === "model/list") {
      response = {
        data: (this.options.models ?? [MODEL_ID]).map((id) => ({
          id,
          displayName: id,
          supportedReasoningEfforts: (
            this.options.reasoningEfforts ?? ["medium"]
          ).map((reasoningEffort) => ({ reasoningEffort })),
        })),
        nextCursor: null,
      };
    } else if (method === "config/read") {
      response = { config: this.options.runtimeConfig ?? {} };
    } else if (method === "turn/interrupt") {
      response = {};
    } else if (method === "thread/start") {
      response = this.options.threadStartResponse ?? {
        thread: {
          id: "thread-test",
          model: MODEL_ID,
          modelProvider: "openai",
          cwd: params.cwd,
          ephemeral: true,
        },
        model: MODEL_ID,
        modelProvider: "openai",
        cwd: params.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        instructionSources: [],
      };
    } else if (method === "turn/start") {
      const threadId = String(params.threadId);
      if (this.options.turnStartBehavior) {
        response = await this.options.turnStartBehavior(threadId, (message) =>
          this.emit(message),
        );
        return response as T;
      }
      const turnId = "turn-test";
      const items = [
        { id: "message-test", type: "agentMessage", text: "Codex ready" },
      ];
      this.emit({
        method: "turn/started",
        params: { threadId, turn: { id: turnId } },
      });
      this.emit({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "completed", items },
        },
      });
      response = { turn: { id: turnId } };
    } else {
      throw new Error(`Unexpected Codex app-server request: ${method}`);
    }

    return response as T;
  }

  respond(
    id: number | string,
    response:
      { result: unknown } | { error: { code: number; message: string } },
  ): void {
    this.serverResponses.push({ id, response });
  }

  private emit(message: { method: string; params: Record<string, unknown> }) {
    for (const handler of this.handlers) handler(message);
  }
}

function sessionOf(mock: MockCodexSession): CodexAppServerSession {
  return mock as unknown as CodexAppServerSession;
}

function turnInput(
  mock: MockCodexSession,
  expectedAccountFingerprint?: string,
) {
  return {
    session: sessionOf(mock),
    cliVersion: CODEX_CLI_VERSION,
    codexHomeFingerprint: CODEX_HOME_FINGERPRINT,
    ...(expectedAccountFingerprint ? { expectedAccountFingerprint } : {}),
    requestedModel: MODEL_ID,
    text: "Reply with exactly: Codex ready",
  };
}

function mockWithAssistantAnswer(answer: string): MockCodexSession {
  return new MockCodexSession({
    runtimeConfig: RESTRICTED_RUNTIME_CONFIG,
    turnStartBehavior: async (threadId, emit) => {
      const turnId = "turn-test";
      emit({
        method: "turn/started",
        params: { threadId, turn: { id: turnId } },
      });
      emit({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            items: [{ id: "answer", type: "agentMessage", text: answer }],
          },
        },
      });
      return { turn: { id: turnId } };
    },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Codex target execution policy", () => {
  it("unwraps Codex's answer envelope around plain text", async () => {
    const mock = mockWithAssistantAnswer(
      JSON.stringify({ answer: "The result is 42." }),
    );

    const result = await executeCodexTurn(turnInput(mock));

    expect(result.text).toBe("The result is 42.");
  });

  it("preserves JSON answers inside Codex's answer envelope", async () => {
    const innerAnswer = ' {\n  "count":"5","sum":"30"\n} ';
    const mock = mockWithAssistantAnswer(
      JSON.stringify({ answer: innerAnswer }),
    );

    const result = await executeCodexTurn(turnInput(mock));

    expect(result.text).toBe(innerAnswer);
  });

  it("leaves noncanonical JSON responses unchanged", async () => {
    const response = JSON.stringify({ answer: "payload", extra: "value" });
    const mock = mockWithAssistantAnswer(response);

    const result = await executeCodexTurn(turnInput(mock));

    expect(result.text).toBe(response);
  });

  it("does not make remote requests for a signal that is already aborted", async () => {
    const mock = new MockCodexSession();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeCodexTurn({ ...turnInput(mock), signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "codex_turn_interrupted",
      outcomeMayBeUnknown: false,
    });
    expect(mock.requests).toEqual([]);
  });

  it("notices cancellation while thread setup is pending and never starts a turn", async () => {
    const threadStartEntered = deferred();
    const finishThreadStart = deferred();
    const mock = new MockCodexSession({
      runtimeConfig: RESTRICTED_RUNTIME_CONFIG,
      beforeRequest: async (method) => {
        if (method !== "thread/start") return;
        threadStartEntered.resolve();
        await finishThreadStart.promise;
      },
    });
    const controller = new AbortController();
    const result = executeCodexTurn({
      ...turnInput(mock),
      signal: controller.signal,
    });
    await threadStartEntered.promise;
    controller.abort();
    finishThreadStart.resolve();

    await expect(result).rejects.toMatchObject({
      code: "codex_turn_interrupted",
      outcomeMayBeUnknown: false,
    });
    expect(mock.requests.some(({ method }) => method === "turn/start")).toBe(
      false,
    );
    expect(
      mock.requests.some(({ method }) => method === "turn/interrupt"),
    ).toBe(false);
  });

  it("notices cancellation from the pre-generation setup callback", async () => {
    const mock = new MockCodexSession({
      runtimeConfig: RESTRICTED_RUNTIME_CONFIG,
    });
    const controller = new AbortController();

    await expect(
      executeCodexTurn({
        ...turnInput(mock),
        signal: controller.signal,
        beforeGeneration: async () => controller.abort(),
      }),
    ).rejects.toMatchObject({
      code: "codex_turn_interrupted",
      outcomeMayBeUnknown: false,
    });
    expect(mock.requests.some(({ method }) => method === "turn/start")).toBe(
      false,
    );
    expect(
      mock.requests.some(({ method }) => method === "turn/interrupt"),
    ).toBe(false);
  });

  it("interrupts a turn started during cancellation and preserves the unknown outcome", async () => {
    const turnStartEntered = deferred();
    const finishTurnStart = deferred();
    const mock = new MockCodexSession({
      runtimeConfig: RESTRICTED_RUNTIME_CONFIG,
      turnStartBehavior: async (threadId, emit) => {
        const turnId = "turn-cancel-race";
        turnStartEntered.resolve();
        await finishTurnStart.promise;
        emit({
          method: "turn/started",
          params: { threadId, turn: { id: turnId } },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed",
              items: [
                { id: "message-test", type: "agentMessage", text: "late" },
              ],
            },
          },
        });
        return { turn: { id: turnId } };
      },
    });
    const controller = new AbortController();
    const result = executeCodexTurn({
      ...turnInput(mock),
      signal: controller.signal,
    });
    await turnStartEntered.promise;
    controller.abort();
    finishTurnStart.resolve();

    await expect(result).rejects.toMatchObject({
      code: "codex_turn_interrupted",
      outcomeMayBeUnknown: true,
    });
    expect(
      mock.requests.filter(({ method }) => method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(
      mock.requests.find(({ method }) => method === "turn/interrupt")?.params,
    ).toEqual({
      threadId: "thread-test",
      turnId: "turn-cancel-race",
    });
  });

  it("preserves the documented app-server config overrides", () => {
    expect(CODEX_APP_SERVER_ARGS).toContain("project_doc_max_bytes=0");
    expect(CODEX_APP_SERVER_ARGS).not.toContain("tools.view_image=false");
  });

  it("accepts only official HTTPS login URLs without credentials or non-default ports", () => {
    expect(isOfficialCodexLoginUrl("https://auth.openai.com/authorize")).toBe(
      true,
    );
    expect(
      isOfficialCodexLoginUrl("https://chatgpt.com:443/device?code=abc"),
    ).toBe(true);
    for (const url of [
      "http://auth.openai.com/authorize",
      "https://auth.openai.com:8443/authorize",
      "https://user:secret@auth.openai.com/authorize",
      "https://auth.openai.com.evil.test/authorize",
    ]) {
      expect(isOfficialCodexLoginUrl(url)).toBe(false);
    }
  });

  it("fails closed before a turn when the runtime does not confirm tool restrictions", async () => {
    const mock = new MockCodexSession();
    const beforeGeneration = vi.fn(async () => undefined);

    await expect(
      executeCodexTurn({ ...turnInput(mock), beforeGeneration }),
    ).rejects.toMatchObject({
      code: "codex_policy_unverified",
      message: expect.stringMatching(
        /did not confirm required tool and instruction restrictions:.*project_doc_max_bytes/u,
      ),
    });
    expect(mock.requests.map((request) => request.method)).toEqual([
      "account/read",
      "model/list",
      "config/read",
    ]);
    expect(
      mock.requests.some((request) => request.method === "thread/start"),
    ).toBe(false);
    expect(
      mock.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
    expect(beforeGeneration).not.toHaveBeenCalled();
  });

  it("accepts the documented feature disables as bounded-native control, not proof that tools are impossible", async () => {
    const mock = new MockCodexSession({
      runtimeConfig: {
        features: {
          shell_tool: false,
          unified_exec: false,
          multi_agent: false,
          apps: false,
        },
        web_search: "disabled",
        project_doc_max_bytes: 0,
        mcp_servers: {},
        approval_policy: "never",
        sandbox_mode: "read-only",
      },
    });

    const generationOrder: string[] = [];
    const result = await executeCodexTurn({
      ...turnInput(mock),
      beforeGeneration: async () => {
        generationOrder.push("reservation");
        expect(mock.requests.at(-1)?.method).toBe("thread/start");
      },
    });

    expect(result.text).toBe("Codex ready");
    expect(result.effectivePolicy).toEqual(codexEffectiveTargetPolicy());
    expect(generationOrder).toEqual(["reservation"]);
    expect(mock.requests.map((request) => request.method)).toEqual([
      "account/read",
      "model/list",
      "config/read",
      "thread/start",
      "turn/start",
    ]);
    expect(mock.requests.at(-1)?.params).not.toHaveProperty("effort");
    expect(codexEffectiveTargetPolicy()).toMatchObject({
      allowedNativeToolCalls: "bounded",
      nativeToolControlStatus: "bounded",
      readOnlyAccess: "bounded",
      isolationPolicyVersion: CODEX_ISOLATION_POLICY_VERSION,
    });
    expect(codexEffectiveTargetPolicy().description).toContain(
      "does not claim native tools are impossible",
    );
  });

  it("requires the schema's top-level model identity in thread/start", async () => {
    const beforeGeneration = vi.fn(async () => undefined);
    const mock = new MockCodexSession({
      runtimeConfig: {
        features: {
          shell_tool: false,
          unified_exec: false,
          multi_agent: false,
          apps: false,
        },
        web_search: "disabled",
        project_doc_max_bytes: 0,
        mcp_servers: {},
        approval_policy: "never",
        sandbox_mode: "read-only",
      },
      threadStartResponse: {
        thread: {
          id: "thread-test",
          model: MODEL_ID,
          modelProvider: "openai",
          cwd: "/promptlab/scratch",
          ephemeral: true,
        },
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
      },
    });

    await expect(
      executeCodexTurn({ ...turnInput(mock), beforeGeneration }),
    ).rejects.toMatchObject({ code: "codex_policy_unverified" });
    expect(
      mock.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
    expect(beforeGeneration).not.toHaveBeenCalled();
  });

  it("binds a target turn to the verified ChatGPT account", async () => {
    const mock = new MockCodexSession();

    await expect(
      executeCodexTurn(turnInput(mock, "b".repeat(64))),
    ).rejects.toMatchObject({
      code: "codex_policy_unverified",
    });
    expect(mock.requests.map((request) => request.method)).toEqual([
      "account/read",
    ]);
  });

  it("does not start a thread when the selected model is absent", async () => {
    const mock = new MockCodexSession({ models: ["another-model"] });

    await expect(executeCodexTurn(turnInput(mock))).rejects.toMatchObject({
      code: "codex_model_unavailable",
    });
    expect(mock.requests.map((request) => request.method)).toEqual([
      "account/read",
      "model/list",
    ]);
  });

  it.each(["high", "max"] as const)(
    "passes the advertised %s reasoning effort to turn/start",
    async (reasoningEffort) => {
      const mock = new MockCodexSession({
        reasoningEfforts: ["low", "medium", "high", "max"],
        runtimeConfig: {
          features: {
            shell_tool: false,
            unified_exec: false,
            multi_agent: false,
            apps: false,
          },
          web_search: "disabled",
          project_doc_max_bytes: 0,
          mcp_servers: {},
          approval_policy: "never",
          sandbox_mode: "read-only",
        },
      });

      await executeCodexTurn({
        ...turnInput(mock),
        reasoningEffort,
      });

      const threadStart = mock.requests.find(
        (request) => request.method === "thread/start",
      );
      const turnStart = mock.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(threadStart?.params).not.toHaveProperty("effort");
      expect(turnStart?.params.effort).toBe(reasoningEffort);
    },
  );

  it("rejects an effort absent from the selected model before starting a thread", async () => {
    const mock = new MockCodexSession({
      reasoningEfforts: ["low", "medium"],
    });
    const beforeGeneration = vi.fn(async () => undefined);

    await expect(
      executeCodexTurn({
        ...turnInput(mock),
        reasoningEffort: "high",
        beforeGeneration,
      }),
    ).rejects.toMatchObject({ code: "codex_reasoning_effort_unavailable" });
    expect(mock.requests.map((request) => request.method)).toEqual([
      "account/read",
      "model/list",
    ]);
    expect(beforeGeneration).not.toHaveBeenCalled();
  });

  it("rejects an unknown item type and interrupts its active turn", () => {
    const mock = new MockCodexSession();
    const violations: Array<{ message: string; outcomeMayBeUnknown: boolean }> =
      [];
    const guard = new CodexTurnProtocolGuard(
      sessionOf(mock),
      "thread-test",
      (message, outcomeMayBeUnknown) =>
        violations.push({ message, outcomeMayBeUnknown }),
    );
    guard.setTurnId("turn-test");

    guard.handle({
      method: "item/started",
      params: {
        threadId: "thread-test",
        turnId: "turn-test",
        item: { id: "unknown-item", type: "futureNativeTool" },
      },
    });

    expect(violations).toEqual([
      {
        message: expect.stringContaining("unrecognized or tool item"),
        outcomeMayBeUnknown: true,
      },
    ]);
    expect(mock.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-test", turnId: "turn-test" },
    });
  });

  it("declines a command approval request and interrupts its active turn", () => {
    const mock = new MockCodexSession();
    const violations: string[] = [];
    const guard = new CodexTurnProtocolGuard(
      sessionOf(mock),
      "thread-test",
      (message) => violations.push(message),
    );

    guard.handle({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-test", turnId: "turn-test" },
    });

    expect(mock.serverResponses).toEqual([
      { id: 42, response: { result: { decision: "decline" } } },
    ]);
    expect(violations).toEqual([
      expect.stringContaining("requested a tool or approval"),
    ]);
    expect(mock.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-test", turnId: "turn-test" },
    });
  });

  it("routes server-initiated JSON-RPC approval requests to the refusal handler", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const outputLines: string[] = [];
    Object.assign(child, {
      stdin,
      stdout,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    stdin.on("data", (chunk: Buffer) => outputLines.push(chunk.toString()));

    const session = new CodexAppServerSession(child);
    const guard = new CodexTurnProtocolGuard(
      session,
      "thread-test",
      () => undefined,
    );
    const unsubscribe = session.onNotification((message) =>
      guard.handle(message),
    );

    stdout.write(
      `${JSON.stringify({
        id: "approval-1",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-test", turnId: "turn-test" },
      })}\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const outgoing = outputLines.flatMap((line) =>
      line
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((entry) => JSON.parse(entry) as Record<string, unknown>),
    );
    expect(outgoing).toContainEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
    expect(outgoing).toContainEqual({
      id: 1,
      method: "turn/interrupt",
      params: { threadId: "thread-test", turnId: "turn-test" },
    });

    unsubscribe();
    const closing = session.close();
    child.emit("exit", 0, null);
    await closing;
  });

  it("retains only standard JSON-RPC error codes from a rejected request", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const session = new CodexAppServerSession(child);

    const unsupportedMethod = session.request("account/read");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    stdout.write(
      `${JSON.stringify({
        id: 1,
        error: { code: -32601, message: "private server detail" },
      })}\n`,
    );
    await expect(unsupportedMethod).rejects.toMatchObject({
      code: "app_server_protocol_error",
      rpcErrorCode: -32601,
      message: "Codex app-server rejected a supported protocol request.",
    });

    const privateErrorCode = session.request("account/read");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    stdout.write(
      `${JSON.stringify({
        id: 2,
        error: { code: 401, message: "private server detail" },
      })}\n`,
    );
    await expect(privateErrorCode).rejects.toMatchObject({
      code: "app_server_protocol_error",
      rpcErrorCode: null,
      message: "Codex app-server rejected a supported protocol request.",
    });

    const closing = session.close();
    child.emit("exit", 0, null);
    await closing;
  });

  it("binds the bounded-native receipt to the account, model, and dedicated Codex home", () => {
    const account: CodexAccountSnapshot = {
      type: "chatgpt",
      planType: "plus",
      identityFingerprint: "c".repeat(64),
    };
    const legacySnapshot = {
      codexVerification: {
        status: "verified",
        adapterVersion: "promptlab-codex-app-server-v1",
        cliVersion: CODEX_CLI_VERSION,
        protocolVersion: `v${CODEX_CLI_VERSION}`,
        requestedModel: MODEL_ID,
        responseModel: MODEL_ID,
        modelProvider: "openai",
        configurationFingerprint: codexConfigurationFingerprint(MODEL_ID),
        toolsPolicyFingerprint: codexTargetPolicyFingerprint(),
        accountFingerprint: account.identityFingerprint,
      },
    };

    expect(
      codexVerificationMatchesConfiguration(legacySnapshot, MODEL_ID),
    ).toBe(false);
    const receipt = codexVerificationReceipt({
      account,
      codexHomeFingerprint: CODEX_HOME_FINGERPRINT,
      requestedModel: MODEL_ID,
      responseModel: MODEL_ID,
      checkedAt: "2026-10-12T00:00:00.000Z",
      usage: null,
      streamObserved: true,
      toolCallsObserved: false,
    });

    expect(receipt).toMatchObject({
      status: "verified",
      codexHomeFingerprint: CODEX_HOME_FINGERPRINT,
      isolationPolicyVersion: CODEX_ISOLATION_POLICY_VERSION,
      accountFingerprint: account.identityFingerprint,
      requestedModel: MODEL_ID,
      responseModel: MODEL_ID,
      effectivePolicy: { sandbox: "bounded-native" },
    });
    expect(
      codexAccountFingerprintFromSnapshot({ codexVerification: receipt }),
    ).toBe(account.identityFingerprint);
    expect(
      codexVerificationMatchesConfiguration(
        { codexVerification: receipt },
        MODEL_ID,
        CODEX_HOME_FINGERPRINT,
      ),
    ).toBe(true);
    expect(
      codexVerificationMatchesConfiguration(
        { codexVerification: receipt },
        MODEL_ID,
        "d".repeat(64),
      ),
    ).toBe(false);
    expect(
      codexVerificationMatchesConfiguration(
        {
          codexVerification: {
            ...receipt,
            isolationPolicyVersion: "obsolete-isolation-policy",
          },
        },
        MODEL_ID,
        CODEX_HOME_FINGERPRINT,
      ),
    ).toBe(false);
    expect(
      codexVerificationMatchesConfiguration(
        { codexVerification: receipt },
        "another-model",
        CODEX_HOME_FINGERPRINT,
      ),
    ).toBe(false);
  });
});

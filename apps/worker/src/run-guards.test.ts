import { describe, expect, it, vi } from "vitest";

import {
  assertRunActive,
  assertRunSourceSelectionAllowed,
  RunNoLongerActiveError,
  startRunStatusWatcher,
  transitionWhileRunIsActive,
  WorkerSourcePolicyError,
} from "./run-guards.ts";

describe("worker run guards", () => {
  it("does not start retrieval or provider work for an invalid queued Codex job", async () => {
    const retrieve = vi.fn(async () => "retrieved context");
    const invokeProvider = vi.fn(async (context: string) => context);
    const executeQueuedRun = async () => {
      assertRunSourceSelectionAllowed("codex_app_server", [
        "11111111-1111-4111-8111-111111111111",
      ]);
      const context = await retrieve();
      return invokeProvider(context);
    };

    await expect(executeQueuedRun()).rejects.toBeInstanceOf(
      WorkerSourcePolicyError,
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(invokeProvider).not.toHaveBeenCalled();
  });

  it("keeps Codex prompt-only runs allowed", () => {
    expect(() =>
      assertRunSourceSelectionAllowed("codex_app_server", []),
    ).not.toThrow();
  });

  it("skips work when cancellation was persisted before the watcher starts", async () => {
    const invokeProvider = vi.fn(async () => "completion");
    const watcher = startRunStatusWatcher(async () => "canceled", 5);

    try {
      await watcher.initialCheck;
      expect(() => assertRunActive(watcher.signal)).toThrow(
        RunNoLongerActiveError,
      );
      expect(invokeProvider).not.toHaveBeenCalled();
    } finally {
      await watcher.stop();
    }
  });

  it("aborts one in-flight provider call when persisted status changes", async () => {
    let persistedStatus = "running";
    const watcher = startRunStatusWatcher(async () => persistedStatus, 5);
    const invokeProvider = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    try {
      await watcher.initialCheck;
      const providerCall = invokeProvider(watcher.signal);
      persistedStatus = "canceled";

      await expect(providerCall).rejects.toBeInstanceOf(RunNoLongerActiveError);
      expect(invokeProvider).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.stop();
    }
  });

  it("ignores a late completion when cancellation won the persisted status race", async () => {
    let persistedStatus = "canceled";
    const writeCompletion = vi.fn(async () => {
      persistedStatus = "succeeded";
    });

    const result = await transitionWhileRunIsActive(
      persistedStatus,
      writeCompletion,
    );

    expect(result).toEqual({ applied: false });
    expect(persistedStatus).toBe("canceled");
    expect(writeCompletion).not.toHaveBeenCalled();
  });
});

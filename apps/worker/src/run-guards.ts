export const RUN_STATUS_POLL_INTERVAL_MS = 500;

export class RunNoLongerActiveError extends Error {
  constructor(readonly persistedStatus: string | null) {
    super("The persisted run is no longer active.");
    this.name = "RunNoLongerActiveError";
  }
}

export class RunStatusWatchError extends Error {
  constructor(override readonly cause: unknown) {
    super("The worker could not confirm that the run is still active.");
    this.name = "RunStatusWatchError";
  }
}

export class WorkerSourcePolicyError extends Error {
  readonly code = "RETRIEVAL_PROVIDER_PERMISSION_REQUIRED";

  constructor() {
    super("Campus retrieval sources cannot be sent to this provider.");
    this.name = "WorkerSourcePolicyError";
  }
}

export interface RunStatusWatcher {
  readonly signal: AbortSignal;
  readonly initialCheck: Promise<void>;
  stop(): Promise<void>;
}

export function startRunStatusWatcher(
  readPersistedStatus: () => Promise<string | null>,
  pollIntervalMs = RUN_STATUS_POLL_INTERVAL_MS,
): RunStatusWatcher {
  const controller = new AbortController();
  const intervalMs = Math.max(1, Math.min(pollIntervalMs, 5_000));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const poll = (): Promise<void> => {
    const currentPoll = (async () => {
      if (stopped || controller.signal.aborted) return;
      try {
        const status = await readPersistedStatus();
        if (status !== "running") {
          controller.abort(new RunNoLongerActiveError(status));
        }
      } catch (error) {
        controller.abort(new RunStatusWatchError(error));
      } finally {
        if (!stopped && !controller.signal.aborted) {
          timer = setTimeout(() => {
            void poll();
          }, intervalMs);
        }
      }
    })();
    inFlight = currentPoll;
    return currentPoll;
  };

  const initialCheck = poll();

  return {
    signal: controller.signal,
    initialCheck,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

export function assertRunActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new RunNoLongerActiveError(null);
  }
}

export function assertRunSourceSelectionAllowed(
  provider: string,
  sourceIds: readonly string[],
): void {
  if (provider !== "campus_gateway" && sourceIds.length > 0) {
    throw new WorkerSourcePolicyError();
  }
}

export async function transitionWhileRunIsActive<T>(
  persistedStatus: string | null,
  transition: () => Promise<T>,
): Promise<{ applied: true; value: T } | { applied: false }> {
  if (persistedStatus !== "running") return { applied: false };
  return { applied: true, value: await transition() };
}

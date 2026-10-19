import { randomUUID } from "node:crypto";

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KNOWLEDGE_EMBEDDING_QUEUE_OPTIONS } from "./knowledge-embedding-retry.ts";

const redisUrl = process.env.PROMPTLAB_REDIS_URL;
const integrationRequested =
  process.env.PROMPTLAB_INTEGRATION_TESTS === "1" && Boolean(redisUrl);

describe.skipIf(!integrationRequested)(
  "isolated Redis queue integration",
  () => {
    let queue: Queue | undefined;
    let worker: Worker | undefined;
    let queueConnection: Redis | undefined;
    let workerConnection: Redis | undefined;
    const queueName = `promptlab-integration-${randomUUID()}`;
    const deliveries = new Map<string, number>();

    beforeAll(async () => {
      const target = new URL(redisUrl!);
      if (target.hostname !== "127.0.0.1" || target.port !== "57379") {
        throw new Error(
          "Queue integration tests require the isolated loopback Redis on port 57379.",
        );
      }
      queueConnection = new Redis(redisUrl!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
      workerConnection = new Redis(redisUrl!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
      queue = new Queue(queueName, { connection: queueConnection });
      worker = new Worker(
        queueName,
        async (job) => {
          const count = (deliveries.get(job.id ?? "") ?? 0) + 1;
          deliveries.set(job.id ?? "", count);
          if (job.name === "knowledge.embedding.execute" && count === 1) {
            throw new Error("simulated transient embedding failure");
          }
          return { accepted: true, ticket: job.data.ticket };
        },
        { connection: workerConnection, concurrency: 1 },
      );
      await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
    }, 15_000);

    afterAll(async () => {
      await worker?.close();
      await queue?.obliterate({ force: true });
      await queue?.close();
      await Promise.all([queueConnection?.quit(), workerConnection?.quit()]);
    });

    it("delivers one bounded local job without invoking a provider", async () => {
      if (!queue || !worker) throw new Error("Redis queue setup did not run.");
      const activeQueue = queue;
      const activeWorker = worker;
      const ticket = randomUUID();
      const completed = new Promise<{ result: unknown; ticket: string }>(
        (resolve, reject) => {
          activeWorker.once("completed", (job, result) =>
            resolve({ result, ticket: String(job.data.ticket) }),
          );
          activeWorker.once("failed", (_job, error) => reject(error));
        },
      );
      await activeQueue.add(
        "integration.local-only",
        { ticket },
        { jobId: ticket, attempts: 1, removeOnComplete: true },
      );
      const outcome = await completed;
      expect(outcome).toEqual({
        result: { accepted: true, ticket },
        ticket,
      });
    }, 10_000);

    it("retries a transient embedding job and completes on the next attempt", async () => {
      if (!queue || !worker) throw new Error("Redis queue setup did not run.");
      const activeQueue = queue;
      const activeWorker = worker;
      const ticket = randomUUID();
      const completed = new Promise<{ result: unknown; attempts: number }>(
        (resolve, reject) => {
          const onCompleted = (job: { id?: string }, result: unknown) => {
            if (job.id !== ticket) return;
            activeWorker.off("failed", onFailed);
            resolve({ result, attempts: deliveries.get(ticket) ?? 0 });
          };
          const onFailed = (job: Job | undefined, error: Error) => {
            if (
              job?.id === ticket &&
              job.attemptsMade >= (job.opts.attempts ?? 1)
            ) {
              activeWorker.off("completed", onCompleted);
              reject(error);
            }
          };
          activeWorker.on("completed", onCompleted);
          activeWorker.on("failed", onFailed);
        },
      );
      await activeQueue.add(
        "knowledge.embedding.execute",
        { ticket },
        {
          jobId: ticket,
          ...KNOWLEDGE_EMBEDDING_QUEUE_OPTIONS,
          removeOnComplete: true,
        },
      );

      await expect(completed).resolves.toEqual({
        result: { accepted: true, ticket },
        attempts: 2,
      });
    }, 10_000);
  },
);

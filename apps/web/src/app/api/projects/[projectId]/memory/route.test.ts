import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  listVerifiedMemories: vi.fn(),
  renderVerifiedMemoryWiki: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => ({ db: mocks.db }),
  };
});

vi.mock("@promptlab/agent/verified-memory", () => ({
  listVerifiedMemories: mocks.listVerifiedMemories,
  renderVerifiedMemoryWiki: mocks.renderVerifiedMemoryWiki,
}));

import { GET } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const runtimeRecord = {
  format: "promptlab-verified-memory-runtime-v1",
  task: "Summarize a campus policy.",
};
const evaluatorRecord = {
  format: "promptlab-verified-memory-v1",
  task: "Held-out private evaluator input.",
  successConditions: [{ criterion: { expected: "private label" } }],
};

function context() {
  return { params: Promise.resolve({ projectId }) };
}

describe("verified memory API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listVerifiedMemories.mockImplementation(
      async (_db: unknown, input: { audience: string }) => ({
        memories: [
          input.audience === "evaluator" ? evaluatorRecord : runtimeRecord,
        ],
        truncated: false,
      }),
    );
    mocks.renderVerifiedMemoryWiki.mockReturnValue("evaluator markdown");
  });

  it("defaults to a task-ranked runtime projection and advertises evaluator export", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory?query=campus+policy&limit=3`,
      ),
      context(),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      verifiedMemories: Array<Record<string, unknown>>;
      evaluatorExportUrl: string;
    };
    expect(payload.verifiedMemories).toEqual([runtimeRecord]);
    expect(JSON.stringify(payload)).not.toContain("private label");
    expect(payload.evaluatorExportUrl).toBe(
      `/api/projects/${projectId}/memory?audience=evaluator`,
    );
    expect(mocks.listVerifiedMemories).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        projectId,
        audience: "runtime",
        query: "campus policy",
        limit: 3,
      }),
    );
  });

  it("requires an explicit evaluator audience for full markdown export", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory?format=markdown&audience=evaluator`,
      ),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("evaluator markdown");
    expect(mocks.listVerifiedMemories).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        projectId,
        audience: "evaluator",
        limit: 100,
      }),
    );
    expect(mocks.renderVerifiedMemoryWiki).toHaveBeenCalledWith(
      [evaluatorRecord],
      { baseUrl: "http://localhost" },
    );
  });

  it("does not allow markdown export through the runtime audience", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory?format=markdown`,
      ),
      context(),
    );
    expect(response.status).toBe(400);
    expect(mocks.listVerifiedMemories).not.toHaveBeenCalled();
  });
});

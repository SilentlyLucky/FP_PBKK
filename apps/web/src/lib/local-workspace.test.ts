import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalWorkspaceService,
  type LocalWorkspaceEvaluationCommandConfiguration,
  type LocalWorkspaceReadResult,
} from "../../../../packages/tools/src/local-workspace.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildLocalWorkspaceKnowledgeSourceInput,
  createLocalWorkspaceRouteHandlers,
} from "./local-workspace-api.ts";
import {
  createLocalWorkspaceRuntime,
  LocalWorkspaceGateway,
  parseLocalWorkspaceEvaluationCommands,
  parseLocalWorkspaceRoots,
  parseLocalWorkspaceWriteProjects,
  type LocalWorkspaceRuntime,
} from "./local-workspace.ts";

const PROJECT_A = "4fd7a8a8-1875-4a83-9c01-4d33b607779c";
const PROJECT_B = "9fcb672c-214c-463d-a590-2f7f62f4e4aa";
const LOCAL_ORIGIN = "http://localhost:3000";
const PROJECT_PATH = "/api/projects/" + PROJECT_A + "/workspace";

let rootA: string;
let rootB: string;

beforeEach(async () => {
  rootA = await mkdtemp(join(tmpdir(), "promptlab-workspace-a-"));
  rootB = await mkdtemp(join(tmpdir(), "promptlab-workspace-b-"));
  await mkdir(join(rootA, "notes"));
  await writeFile(
    join(rootA, "notes", "guide.md"),
    "A local evidence needle for bounded workspace search.",
    "utf8",
  );
  await writeFile(join(rootA, "notes", "draft.txt"), "Draft text.", "utf8");
  await writeFile(
    join(rootA, "notes", "tool.ts"),
    "const local = true;",
    "utf8",
  );
  await writeFile(join(rootB, "other.txt"), "Project B material.", "utf8");
});

afterEach(async () => {
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    origin?: string;
    host?: string;
    urlOrigin?: string;
    fetchSite?: string;
    forwardedHost?: string;
    forwardedProto?: string;
    forwardedPort?: string;
    forwarded?: string;
  } = {},
): Request {
  const method = options.method ?? "GET";
  const headers = new Headers({
    host: options.host ?? "localhost:3000",
    origin: options.origin ?? LOCAL_ORIGIN,
  });
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  if (options.forwardedHost)
    headers.set("x-forwarded-host", options.forwardedHost);
  if (options.forwardedProto)
    headers.set("x-forwarded-proto", options.forwardedProto);
  if (options.forwardedPort)
    headers.set("x-forwarded-port", options.forwardedPort);
  if (options.forwarded) headers.set("forwarded", options.forwarded);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return new Request((options.urlOrigin ?? LOCAL_ORIGIN) + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function makeRuntime(
  now: () => number = Date.now,
  ttlMs?: number,
  writeConfigured = false,
  evaluationCommands: readonly LocalWorkspaceEvaluationCommandConfiguration[] = [],
): Promise<LocalWorkspaceRuntime> {
  const roots = [
    { projectId: PROJECT_A, rootPath: rootA },
    { projectId: PROJECT_B, rootPath: rootB },
  ] as const;
  const service = await createLocalWorkspaceService({
    allowedProjectRoots: roots,
    enableWrites: writeConfigured,
    allowedWriteProjectIds: writeConfigured ? [PROJECT_A] : [],
    workspaceEvaluationCommands: evaluationCommands,
  });
  return {
    kind: "available",
    gateway: new LocalWorkspaceGateway(
      service,
      roots.map((root) => root.projectId),
      now,
      ttlMs,
      writeConfigured ? [PROJECT_A] : [],
    ),
  };
}

function handlersFor(
  runtime: LocalWorkspaceRuntime,
  overrides: Parameters<typeof createLocalWorkspaceRouteHandlers>[0] = {},
) {
  return createLocalWorkspaceRouteHandlers({
    getRuntime: async () => runtime,
    ...overrides,
  });
}

async function approvedGrant(
  handlers: ReturnType<typeof createLocalWorkspaceRouteHandlers>,
  projectId = PROJECT_A,
) {
  const response = await handlers.approve(
    makeRequest("/api/projects/" + projectId + "/workspace/grants", {
      method: "POST",
      body: { approval: "read_only_project_root" },
    }),
    projectId,
  );
  const result = (await response.json()) as { grantId?: string };
  expect(response.status).toBe(201);
  expect(result.grantId).toBeTruthy();
  return result.grantId!;
}

async function approvedWriteGrant(
  handlers: ReturnType<typeof createLocalWorkspaceRouteHandlers>,
  projectId = PROJECT_A,
) {
  const response = await handlers.approveWrite(
    makeRequest("/api/projects/" + projectId + "/workspace/grants/write", {
      method: "POST",
      body: { approval: "workspace_write_project_root" },
    }),
    projectId,
  );
  const result = (await response.json()) as { grantId?: string };
  expect(response.status).toBe(201);
  expect(result.grantId).toBeTruthy();
  return result.grantId!;
}

describe("local workspace project configuration", () => {
  it("keeps environment roots available alongside durable registered roots", async () => {
    const registeredRootId = "5abbb6b5-c185-4e14-93cc-d73b6ee6ef76";
    const runtime = await createLocalWorkspaceRuntime(
      JSON.stringify([{ projectId: PROJECT_A, rootPath: rootA }]),
      undefined,
      { enabled: false },
      [
        {
          projectId: PROJECT_A,
          rootId: registeredRootId,
          rootPath: rootB,
          displayName: "registered notes",
          createdAt: new Date().toISOString(),
          available: true,
        },
      ],
    );
    if (runtime.kind !== "available")
      throw new Error("Expected both read-only roots to be available.");

    expect(runtime.gateway.listRoots(PROJECT_A)).toEqual([
      {
        rootId: "environment:" + PROJECT_A,
        displayName: "Folder dari konfigurasi server",
        source: "environment",
        available: true,
      },
      {
        rootId: registeredRootId,
        displayName: "registered notes",
        source: "registered",
        available: true,
      },
    ]);
    const grant = runtime.gateway.issueGrant(PROJECT_A, registeredRootId);
    const listing = await runtime.gateway.list(PROJECT_A, grant.grantId, "");
    expect(listing.entries).toEqual([
      { name: "other.txt", path: "other.txt", kind: "file" },
    ]);
  });

  it("defaults to an empty server allowlist and rejects malformed configuration", async () => {
    expect(parseLocalWorkspaceRoots(undefined)).toEqual({ roots: [] });
    expect(parseLocalWorkspaceRoots("[]")).toEqual({ roots: [] });
    expect(parseLocalWorkspaceRoots("{")).toEqual({ invalid: true });
    expect(
      parseLocalWorkspaceRoots(
        JSON.stringify([{ projectId: PROJECT_A, rootPath: "relative" }]),
      ),
    ).toEqual({ invalid: true });
    expect(
      parseLocalWorkspaceRoots(
        JSON.stringify([
          { projectId: PROJECT_A, rootPath: rootA },
          { projectId: PROJECT_A, rootPath: rootB },
        ]),
      ),
    ).toEqual({ invalid: true });

    const runtime = await createLocalWorkspaceRuntime(undefined);
    expect(runtime).toEqual({ kind: "unavailable", reason: "not_configured" });

    expect(parseLocalWorkspaceWriteProjects(undefined)).toEqual({
      projectIds: [],
    });
    expect(parseLocalWorkspaceEvaluationCommands(undefined)).toEqual({
      commands: [],
    });
    expect(
      parseLocalWorkspaceWriteProjects(JSON.stringify([PROJECT_A, PROJECT_B])),
    ).toEqual({ projectIds: [PROJECT_A, PROJECT_B] });
    expect(parseLocalWorkspaceWriteProjects("not-json")).toEqual({
      invalid: true,
    });
    const evaluationCommand = {
      id: "unit-check",
      label: "Unit check",
      executable: "/usr/bin/node",
      args: ["-e", "process.exit(0)"],
    };
    expect(
      parseLocalWorkspaceEvaluationCommands(
        JSON.stringify([
          { projectId: PROJECT_A, commands: [evaluationCommand] },
        ]),
      ),
    ).toEqual({
      commands: [{ projectId: PROJECT_A, command: evaluationCommand }],
    });
    expect(
      parseLocalWorkspaceEvaluationCommands(
        JSON.stringify([
          {
            projectId: PROJECT_A,
            commands: [{ ...evaluationCommand, shell: true }],
          },
        ]),
      ),
    ).toEqual({ invalid: true });
    expect(
      parseLocalWorkspaceEvaluationCommands(
        JSON.stringify([
          {
            projectId: PROJECT_A,
            commands: [evaluationCommand, evaluationCommand],
          },
        ]),
      ),
    ).toEqual({ invalid: true });
    expect(
      parseLocalWorkspaceWriteProjects(JSON.stringify([PROJECT_A, PROJECT_A])),
    ).toEqual({ invalid: true });
  });

  it("enables writes only for explicitly listed configured projects", async () => {
    const readRoots = JSON.stringify([
      { projectId: PROJECT_A, rootPath: rootA },
      { projectId: PROJECT_B, rootPath: rootB },
    ]);
    const enabled = await createLocalWorkspaceRuntime(readRoots, undefined, {
      enabled: true,
      rawProjectIds: JSON.stringify([PROJECT_A]),
    });
    expect(enabled.kind).toBe("available");
    if (enabled.kind === "available") {
      expect(enabled.gateway.isWriteConfigured(PROJECT_A)).toBe(true);
      expect(enabled.gateway.isWriteConfigured(PROJECT_B)).toBe(false);
    }

    const malformedWriteConfig = await createLocalWorkspaceRuntime(
      readRoots,
      undefined,
      { enabled: true, rawProjectIds: "not-json" },
    );
    expect(malformedWriteConfig.kind).toBe("available");
    if (malformedWriteConfig.kind === "available") {
      expect(malformedWriteConfig.gateway.isProjectConfigured(PROJECT_A)).toBe(
        true,
      );
      expect(malformedWriteConfig.gateway.isWriteConfigured(PROJECT_A)).toBe(
        false,
      );
    }
  });

  it("does not accept browser-supplied roots and reports the empty state safely", async () => {
    const runtime = await createLocalWorkspaceRuntime(undefined);
    const handlers = handlersFor(runtime);
    const status = await handlers.status(makeRequest(PROJECT_PATH), PROJECT_A);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      projectConfigured: false,
      reason: "not_configured",
      isolatedEvaluation: {
        executionAvailable: false,
        reasonCode: "project_not_configured",
      },
    });

    const approval = await handlers.approve(
      makeRequest(PROJECT_PATH + "/grants", {
        method: "POST",
        body: {
          approval: "read_only_project_root",
          rootPath: rootA,
        },
      }),
      PROJECT_A,
    );
    expect(approval.status).toBe(400);
    expect(await approval.text()).not.toContain(rootA);
  });
});

describe("local workspace route guards and grants", () => {
  it("requires a same-origin loopback request", async () => {
    const handlers = handlersFor(await makeRuntime());
    const crossOrigin = await handlers.status(
      makeRequest(PROJECT_PATH, { origin: "https://attacker.example" }),
      PROJECT_A,
    );
    expect(crossOrigin.status).toBe(403);
    const nonSerializedOrigin = await handlers.status(
      makeRequest(PROJECT_PATH, { origin: LOCAL_ORIGIN + "/nested" }),
      PROJECT_A,
    );
    expect(nonSerializedOrigin.status).toBe(403);

    const remoteHost = await handlers.status(
      makeRequest(PROJECT_PATH, {
        host: "10.0.0.5:3000",
        urlOrigin: "http://10.0.0.5:3000",
      }),
      PROJECT_A,
    );
    expect(remoteHost.status).toBe(403);

    const forwarded = await handlers.status(
      makeRequest(PROJECT_PATH, { fetchSite: "cross-site" }),
      PROJECT_A,
    );
    expect(forwarded.status).toBe(403);

    const nextForwarded = await handlers.status(
      makeRequest(PROJECT_PATH, {
        forwardedHost: "localhost:3000",
        forwardedProto: "http",
        forwardedPort: "3000",
      }),
      PROJECT_A,
    );
    expect(nextForwarded.status).toBe(200);

    const nextReconstructedOrigin = await handlers.status(
      makeRequest(PROJECT_PATH, {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        forwardedHost: "127.0.0.1:3000",
        forwardedProto: "http",
        forwardedPort: "3000",
      }),
      PROJECT_A,
    );
    expect(nextReconstructedOrigin.status).toBe(200);

    const spoofedForwardedHost = await handlers.status(
      makeRequest(PROJECT_PATH, { forwardedHost: "attacker.example" }),
      PROJECT_A,
    );
    expect(spoofedForwardedHost.status).toBe(403);

    const spoofedForwardedProtocol = await handlers.status(
      makeRequest(PROJECT_PATH, { forwardedProto: "https" }),
      PROJECT_A,
    );
    expect(spoofedForwardedProtocol.status).toBe(403);

    const untrustedStandardForwarded = await handlers.status(
      makeRequest(PROJECT_PATH, {
        forwarded: "for=127.0.0.1;host=localhost:3000;proto=http",
      }),
      PROJECT_A,
    );
    expect(untrustedStandardForwarded.status).toBe(403);

    const sameOriginWithoutOriginHeader = await handlers.status(
      makeRequest(PROJECT_PATH, {
        origin: "",
        fetchSite: "same-origin",
      }),
      PROJECT_A,
    );
    expect(sameOriginWithoutOriginHeader.status).toBe(200);
  });

  it("accepts Next's unspecified bind URL only with explicit local opt-in", async () => {
    const handlers = handlersFor(await makeRuntime());
    const previous =
      process.env.PROMPTLAB_LOCAL_WORKSPACE_ALLOW_UNSPECIFIED_BIND_HOST;

    try {
      delete process.env.PROMPTLAB_LOCAL_WORKSPACE_ALLOW_UNSPECIFIED_BIND_HOST;
      const rejected = await handlers.status(
        makeRequest(PROJECT_PATH, { urlOrigin: "http://0.0.0.0:3000" }),
        PROJECT_A,
      );
      expect(rejected.status).toBe(403);

      process.env.PROMPTLAB_LOCAL_WORKSPACE_ALLOW_UNSPECIFIED_BIND_HOST = "1";
      const accepted = await handlers.status(
        makeRequest(PROJECT_PATH, { urlOrigin: "http://0.0.0.0:3000" }),
        PROJECT_A,
      );
      expect(accepted.status).toBe(200);
    } finally {
      if (previous === undefined) {
        delete process.env
          .PROMPTLAB_LOCAL_WORKSPACE_ALLOW_UNSPECIFIED_BIND_HOST;
      } else {
        process.env.PROMPTLAB_LOCAL_WORKSPACE_ALLOW_UNSPECIFIED_BIND_HOST =
          previous;
      }
    }
  });

  it("lists, reads, and searches under one approved project grant", async () => {
    const handlers = handlersFor(await makeRuntime());
    const grantId = await approvedGrant(handlers);

    const listed = await handlers.list(
      makeRequest(PROJECT_PATH + "/grants/" + grantId + "/list?path=notes"),
      PROJECT_A,
      grantId,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      path: "notes",
      entries: expect.arrayContaining([
        { name: "guide.md", path: "notes/guide.md", kind: "file" },
      ]),
    });

    const read = await handlers.read(
      makeRequest(
        PROJECT_PATH + "/grants/" + grantId + "/read?path=notes%2Fguide.md",
      ),
      PROJECT_A,
      grantId,
    );
    expect(read.status).toBe(200);
    const readPayload = await read.json();
    expect(readPayload).toMatchObject({
      path: "notes/guide.md",
      encoding: "utf-8",
      content: "A local evidence needle for bounded workspace search.",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(readPayload).not.toHaveProperty("rawBytes");

    const searched = await handlers.search(
      makeRequest(
        PROJECT_PATH + "/grants/" + grantId + "/search?q=evidence%20needle",
      ),
      PROJECT_A,
      grantId,
    );
    expect(searched.status).toBe(200);
    await expect(searched.json()).resolves.toMatchObject({
      matches: [
        expect.objectContaining({
          path: "notes/guide.md",
          snippet: expect.stringContaining("evidence needle"),
        }),
      ],
    });
  });

  it("binds grants to their project and supports explicit revocation", async () => {
    const handlers = handlersFor(await makeRuntime());
    const grantId = await approvedGrant(handlers);
    const crossProject = await handlers.list(
      makeRequest(
        "/api/projects/" + PROJECT_B + "/workspace/grants/" + grantId + "/list",
      ),
      PROJECT_B,
      grantId,
    );
    expect(crossProject.status).toBe(404);

    const revoked = await handlers.revoke(
      makeRequest(PROJECT_PATH + "/grants/" + grantId, { method: "DELETE" }),
      PROJECT_A,
      grantId,
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await handlers.read(
      makeRequest(
        PROJECT_PATH + "/grants/" + grantId + "/read?path=notes%2Fguide.md",
      ),
      PROJECT_A,
      grantId,
    );
    expect(afterRevoke.status).toBe(404);
  });

  it("expires a grant before returning a later read", async () => {
    let clock = 10_000;
    const handlers = handlersFor(await makeRuntime(() => clock, 500));
    const grantId = await approvedGrant(handlers);
    clock += 500;

    const expired = await handlers.read(
      makeRequest(
        PROJECT_PATH + "/grants/" + grantId + "/read?path=notes%2Fguide.md",
      ),
      PROJECT_A,
      grantId,
    );
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({
      error: "GRANT_EXPIRED",
    });
  });

  it("reclaims expired gateway grants before issuing a replacement", async () => {
    let clock = 10_000;
    const runtime = await makeRuntime(() => clock, 250, true);
    if (runtime.kind !== "available")
      throw new Error("Expected local runtime.");
    for (let index = 0; index < 128; index += 1) {
      runtime.gateway.issueWriteGrant(PROJECT_A);
    }
    clock += 5 * 60 * 1_000;

    expect(runtime.gateway.issueGrant(PROJECT_A).grantId).toBeTruthy();
  });

  it("does not return filesystem roots in grant or operation responses", async () => {
    const handlers = handlersFor(await makeRuntime());
    const grantId = await approvedGrant(handlers);
    expect(grantId).not.toContain(rootA);

    const listed = await handlers.list(
      makeRequest(PROJECT_PATH + "/grants/" + grantId + "/list"),
      PROJECT_A,
      grantId,
    );
    expect(await listed.text()).not.toContain(rootA);
  });

  it("keeps write unavailable by default and requires a separate write grant", async () => {
    const handlers = handlersFor(await makeRuntime());
    const status = await handlers.status(makeRequest(PROJECT_PATH), PROJECT_A);
    await expect(status.json()).resolves.toMatchObject({
      projectConfigured: true,
      access: "read_only",
      writeAvailable: false,
      writeGrantDurationSeconds: null,
      isolatedEvaluation: {
        executionAvailable: false,
        reasonCode: "workspace_write_not_configured",
      },
    });

    const missingIntent = await handlers.approveWrite(
      makeRequest(PROJECT_PATH + "/grants/write", {
        method: "POST",
        body: { approval: "workspace_write_project_root", rootPath: rootA },
      }),
      PROJECT_A,
    );
    expect(missingIntent.status).toBe(400);

    const unavailable = await handlers.approveWrite(
      makeRequest(PROJECT_PATH + "/grants/write", {
        method: "POST",
        body: { approval: "workspace_write_project_root" },
      }),
      PROJECT_A,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(rootA);
  });

  it("runs only a server-allowlisted test ID against a proposed patch", async () => {
    const evaluatorSource =
      "const fs = require('fs'); const value = fs.readFileSync('notes/draft.txt', 'utf8'); console.log(JSON.stringify({ value })); process.exit(value === 'Reviewed candidate.\\n' ? 0 : 1);";
    const handlers = handlersFor(
      await makeRuntime(Date.now, undefined, true, [
        {
          projectId: PROJECT_A,
          command: {
            id: "draft-check",
            label: "Draft file check",
            executable: process.execPath,
            args: ["-e", evaluatorSource],
          },
        },
      ]),
    );
    const status = await handlers.status(makeRequest(PROJECT_PATH), PROJECT_A);
    await expect(status.json()).resolves.toMatchObject({
      isolatedEvaluation: {
        executionAvailable: true,
        reasonCode: null,
        tests: [
          { id: "draft-check", label: "Draft file check", available: true },
        ],
      },
    });

    const readGrantId = await approvedGrant(handlers);
    const readGrantAttempt = await handlers.evaluatePatch(
      makeRequest(
        PROJECT_PATH + "/grants/" + readGrantId + "/patches/unknown/evaluate",
        {
          method: "POST",
          body: { testId: "draft-check" },
        },
      ),
      PROJECT_A,
      readGrantId,
      "unknown",
    );
    expect(readGrantAttempt.status).toBe(503);

    const writeGrantId = await approvedWriteGrant(handlers);
    const proposal = await handlers.proposePatch(
      makeRequest(PROJECT_PATH + "/grants/" + writeGrantId + "/patches", {
        method: "POST",
        body: {
          path: "notes/draft.txt",
          content: "Reviewed candidate.\n",
          source: "user_editor",
        },
      }),
      PROJECT_A,
      writeGrantId,
    );
    const { patchId } = (await proposal.json()) as { patchId: string };
    const target =
      PROJECT_PATH +
      "/grants/" +
      writeGrantId +
      "/patches/" +
      patchId +
      "/evaluate";

    const browserCommandAttempt = await handlers.evaluatePatch(
      makeRequest(target, {
        method: "POST",
        body: {
          testId: "draft-check",
          executable: "/usr/bin/touch",
          args: ["notes/unsafe"],
        },
      }),
      PROJECT_A,
      writeGrantId,
      patchId,
    );
    expect(browserCommandAttempt.status).toBe(400);

    const evaluation = await handlers.evaluatePatch(
      makeRequest(target, {
        method: "POST",
        body: { testId: "draft-check" },
      }),
      PROJECT_A,
      writeGrantId,
      patchId,
    );
    expect(evaluation.status).toBe(200);
    await expect(evaluation.json()).resolves.toMatchObject({
      status: "completed",
      assessment: "candidate_improved",
      commandId: "draft-check",
      baseline: {
        status: "completed",
        exitCode: 1,
        stdout: JSON.stringify({ value: "Draft text." }) + "\n",
      },
      candidate: {
        status: "completed",
        exitCode: 0,
        stdout: JSON.stringify({ value: "Reviewed candidate.\n" }) + "\n",
      },
    });
    await expect(
      readFile(join(rootA, "notes", "draft.txt"), "utf8"),
    ).resolves.toBe("Draft text.");

    await handlers.approvePatch(
      makeRequest(
        PROJECT_PATH +
          "/grants/" +
          writeGrantId +
          "/patches/" +
          patchId +
          "/approve",
        { method: "POST", body: { approval: "apply_exact_patch" } },
      ),
      PROJECT_A,
      writeGrantId,
      patchId,
    );
    const approvedPatchAttempt = await handlers.evaluatePatch(
      makeRequest(target, {
        method: "POST",
        body: { testId: "draft-check" },
      }),
      PROJECT_A,
      writeGrantId,
      patchId,
    );
    expect(approvedPatchAttempt.status).toBe(409);
  });

  it("requires a write grant and applies, repeats, and rolls back the exact reviewed proposal", async () => {
    const handlers = handlersFor(await makeRuntime(Date.now, undefined, true));
    const readGrantId = await approvedGrant(handlers);
    const writeGrantId = await approvedWriteGrant(handlers);
    const patchPath = PROJECT_PATH + "/grants/" + writeGrantId + "/patches";
    const patchBody = {
      path: "notes/draft.txt",
      content: "Reviewed local edit.\n",
      source: "user_editor",
    };

    const readCannotPropose = await handlers.proposePatch(
      makeRequest(PROJECT_PATH + "/grants/" + readGrantId + "/patches", {
        method: "POST",
        body: patchBody,
      }),
      PROJECT_A,
      readGrantId,
    );
    expect(readCannotPropose.status).toBe(503);

    const proposal = await handlers.proposePatch(
      makeRequest(patchPath, { method: "POST", body: patchBody }),
      PROJECT_A,
      writeGrantId,
    );
    expect(proposal.status).toBe(201);
    const proposed = (await proposal.json()) as {
      patchId: string;
      beforeHash: string;
      afterHash: string;
      status: string;
      diff: string;
    };
    expect(proposed).toMatchObject({
      status: "proposed",
      beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      afterHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(proposed.diff).toContain("-Draft text.");
    expect(proposed.diff).toContain("+Reviewed local edit.");

    const target =
      PROJECT_PATH + "/grants/" + writeGrantId + "/patches/" + proposed.patchId;
    const fetched = await handlers.getPatch(
      makeRequest(target),
      PROJECT_A,
      writeGrantId,
      proposed.patchId,
    );
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      patchId: proposed.patchId,
      afterHash: proposed.afterHash,
    });
    const apply = () =>
      handlers.approvePatch(
        makeRequest(target + "/approve", {
          method: "POST",
          body: { approval: "apply_exact_patch" },
        }),
        PROJECT_A,
        writeGrantId,
        proposed.patchId,
      );

    const applied = await apply();
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      repeated: false,
      patch: { status: "approved", afterHash: proposed.afterHash },
    });
    const repeated = await apply();
    await expect(repeated.json()).resolves.toMatchObject({ repeated: true });

    const rollback = await handlers.rollbackPatch(
      makeRequest(target + "/rollback", {
        method: "POST",
        body: { approval: "restore_exact_before_bytes" },
      }),
      PROJECT_A,
      writeGrantId,
      proposed.patchId,
    );
    expect(rollback.status).toBe(200);
    await expect(rollback.json()).resolves.toMatchObject({
      repeated: false,
      patch: { status: "rolled_back", beforeHash: proposed.beforeHash },
    });
    const repeatedRollback = await handlers.rollbackPatch(
      makeRequest(target + "/rollback", {
        method: "POST",
        body: { approval: "restore_exact_before_bytes" },
      }),
      PROJECT_A,
      writeGrantId,
      proposed.patchId,
    );
    await expect(repeatedRollback.json()).resolves.toMatchObject({
      repeated: true,
    });

    const restored = await handlers.read(
      makeRequest(
        PROJECT_PATH +
          "/grants/" +
          writeGrantId +
          "/read?path=notes%2Fdraft.txt",
      ),
      PROJECT_A,
      writeGrantId,
    );
    await expect(restored.json()).resolves.toMatchObject({
      content: "Draft text.",
    });
  });

  it("returns a conflict when the file changes after proposal creation", async () => {
    const handlers = handlersFor(await makeRuntime(Date.now, undefined, true));
    const writeGrantId = await approvedWriteGrant(handlers);
    const proposal = await handlers.proposePatch(
      makeRequest(PROJECT_PATH + "/grants/" + writeGrantId + "/patches", {
        method: "POST",
        body: {
          path: "notes/draft.txt",
          content: "Candidate bytes",
          source: "user_editor",
        },
      }),
      PROJECT_A,
      writeGrantId,
    );
    const { patchId } = (await proposal.json()) as { patchId: string };
    await writeFile(
      join(rootA, "notes", "draft.txt"),
      "Changed outside.",
      "utf8",
    );

    const conflict = await handlers.approvePatch(
      makeRequest(
        PROJECT_PATH +
          "/grants/" +
          writeGrantId +
          "/patches/" +
          patchId +
          "/approve",
        { method: "POST", body: { approval: "apply_exact_patch" } },
      ),
      PROJECT_A,
      writeGrantId,
      patchId,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "PATCH_CONFLICT",
    });
    await expect(
      readFile(join(rootA, "notes", "draft.txt"), "utf8"),
    ).resolves.toBe("Changed outside.");
  });

  it("rejects a proposal when its read snapshot is stale", async () => {
    const handlers = handlersFor(await makeRuntime(Date.now, undefined, true));
    const readGrantId = await approvedGrant(handlers);
    const writeGrantId = await approvedWriteGrant(handlers);
    const snapshotResponse = await handlers.read(
      makeRequest(
        PROJECT_PATH +
          "/grants/" +
          readGrantId +
          "/read?path=notes%2Fdraft.txt",
      ),
      PROJECT_A,
      readGrantId,
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      contentHash: string;
    };
    const changedContent = "Changed while the answer was being drafted.\n";
    await writeFile(join(rootA, "notes", "draft.txt"), changedContent, "utf8");

    const proposal = await handlers.proposePatch(
      makeRequest(PROJECT_PATH + "/grants/" + writeGrantId + "/patches", {
        method: "POST",
        body: {
          path: "notes/draft.txt",
          content: "Stale answer text.\n",
          source: "user_editor",
          expectedBeforeHash: snapshot.contentHash,
        },
      }),
      PROJECT_A,
      writeGrantId,
    );

    expect(proposal.status).toBe(409);
    await expect(proposal.json()).resolves.toMatchObject({
      code: "PATCH_CONFLICT",
    });
    await expect(
      readFile(join(rootA, "notes", "draft.txt"), "utf8"),
    ).resolves.toBe(changedContent);
  });

  it("rejects malformed expected hashes at the route and direct gateway", async () => {
    const runtime = await makeRuntime(Date.now, undefined, true);
    const handlers = handlersFor(runtime);
    const writeGrantId = await approvedWriteGrant(handlers);

    for (const expectedBeforeHash of [
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
      7,
    ]) {
      const response = await handlers.proposePatch(
        makeRequest(PROJECT_PATH + "/grants/" + writeGrantId + "/patches", {
          method: "POST",
          body: {
            path: "notes/draft.txt",
            content: "Invalid snapshot token.",
            source: "user_editor",
            expectedBeforeHash,
          },
        }),
        PROJECT_A,
        writeGrantId,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "REQUEST_INVALID",
      });
    }

    if (runtime.kind !== "available") {
      throw new Error("Expected the test workspace to be available");
    }
    const directGrant = runtime.gateway.issueWriteGrant(PROJECT_A);
    await expect(
      runtime.gateway.proposePatch(
        PROJECT_A,
        directGrant.grantId,
        "notes/draft.txt",
        "Invalid direct gateway token.",
        "A".repeat(64),
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readFile(join(rootA, "notes", "draft.txt"), "utf8"),
    ).resolves.toBe("Draft text.");
  });
});

describe("local file source import", () => {
  it("keeps the local read grant and requires a configured local database", async () => {
    const persistSource = vi.fn(async () => ({
      sourceId: "source-id",
      version: 1,
      checksum: "a".repeat(64),
      chunkCount: 1,
      updated: false,
      permission: "local_only" as const,
    }));
    const handlers = handlersFor(await makeRuntime(), {
      databaseConfigured: () => false,
      persistSource,
    });
    const grantId = await approvedGrant(handlers);
    const target = PROJECT_PATH + "/grants/" + grantId + "/import";

    const noDatabase = await handlers.import(
      makeRequest(target, {
        method: "POST",
        body: { path: "notes/guide.md" },
      }),
      PROJECT_A,
      grantId,
    );
    expect(noDatabase.status).toBe(503);
    expect(persistSource).not.toHaveBeenCalled();
  });

  it("imports text files with any extension as indexing-ready sources", async () => {
    const persistSource = vi.fn(
      async (_projectId: string, file: LocalWorkspaceReadResult) => ({
        sourceId: "source-id",
        version: 2,
        checksum: "b".repeat(64),
        chunkCount: 1,
        updated: true,
        permission: "campus_indexer_allowed" as const,
      }),
    );
    const handlers = handlersFor(await makeRuntime(), {
      databaseConfigured: () => true,
      persistSource,
    });
    const grantId = await approvedGrant(handlers);
    const target = PROJECT_PATH + "/grants/" + grantId + "/import";

    const imported = await handlers.import(
      makeRequest(target, {
        method: "POST",
        body: {
          path: "notes/guide.md",
        },
      }),
      PROJECT_A,
      grantId,
    );
    expect(imported.status).toBe(201);
    const importedPayload = await imported.json();
    expect(importedPayload).toMatchObject({
      version: 2,
      updated: true,
      permission: "campus_indexer_allowed",
    });
    expect(persistSource).toHaveBeenCalledWith(
      PROJECT_A,
      expect.objectContaining({ path: "notes/guide.md" }),
    );
    expect(JSON.stringify(importedPayload)).not.toContain(rootA);

    const importedTypeScript = await handlers.import(
      makeRequest(target, {
        method: "POST",
        body: { path: "notes/tool.ts" },
      }),
      PROJECT_A,
      grantId,
    );
    expect(importedTypeScript.status).toBe(201);
    expect(persistSource).toHaveBeenCalledTimes(2);
    expect(persistSource).toHaveBeenLastCalledWith(
      PROJECT_A,
      expect.objectContaining({ path: "notes/tool.ts" }),
    );
  });

  it("stores only relative provenance and the imported content hash", () => {
    const guideContent = "Short local content.";
    const input = buildLocalWorkspaceKnowledgeSourceInput(
      PROJECT_A,
      {
        path: "notes/guide.md",
        encoding: "utf-8",
        bytes: Buffer.byteLength(guideContent),
        content: guideContent,
        contentHash: createHash("sha256").update(guideContent).digest("hex"),
        rawBytes: new TextEncoder().encode(guideContent),
      },
      new Date("2026-10-16T00:00:00.000Z"),
    );
    expect(input).toMatchObject({
      projectId: PROJECT_A,
      displayName: "guide.md",
      sourceKind: "upload",
      permission: "campus_indexer_allowed",
      sourceRef: null,
      sourceMetadata: {
        origin: "local_workspace",
        relativePath: "notes/guide.md",
        importedAt: "2026-10-16T00:00:00.000Z",
        extractedTextSha256: createHash("sha256")
          .update(guideContent)
          .digest("hex"),
      },
      rawByteSha256: createHash("sha256").update(guideContent).digest("hex"),
      rawByteSize: Buffer.byteLength(guideContent),
    });
    expect(JSON.stringify(input.sourceMetadata)).not.toContain(rootA);
    expect(
      buildLocalWorkspaceKnowledgeSourceInput(
        PROJECT_A,
        {
          path: "notes/tool.ts",
          encoding: "utf-8",
          bytes: 1,
          content: "x",
          contentHash: createHash("sha256").update("x").digest("hex"),
          rawBytes: new TextEncoder().encode("x"),
        },
        new Date(),
      ),
    ).toMatchObject({ displayName: "tool.ts", contentType: "text/plain" });
  });
});

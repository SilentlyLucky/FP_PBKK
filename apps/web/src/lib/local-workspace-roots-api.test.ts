import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalWorkspaceDirectoryPicker } from "../../../../packages/tools/src/local-workspace-picker.ts";
import {
  createLocalWorkspaceRuntime,
  type LocalWorkspaceRuntime,
} from "./local-workspace.ts";
import { createLocalWorkspaceRouteHandlers } from "./local-workspace-api.ts";
import { LocalWorkspaceRootRegistry } from "./local-workspace-roots.ts";
import { createLocalWorkspaceRootHandlers } from "./local-workspace-roots-api.ts";

const PROJECT_ID = "f3b16568-80c7-45f7-9f14-1bfda4fc23c8";
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "promptlab-roots-api-"));
  temporaryDirectories.push(directory);
  return directory;
}

function localRequest(
  url: string,
  method = "GET",
  body?: unknown,
  origin = "http://localhost:3000",
) {
  return new Request("http://localhost:3000" + url, {
    method,
    headers: {
      host: "localhost:3000",
      origin,
      "sec-fetch-site":
        origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local workspace root API", () => {
  it("registers a chooser token, grants that root read-only access, and revokes it", async () => {
    const home = await temporaryDirectory();
    const projectRoot = path.join(home, "FP_PBKK");
    const documents = path.join(projectRoot, "docs");
    await mkdir(documents, { recursive: true });
    await writeFile(path.join(documents, "readme.md"), "project context");
    const registry = new LocalWorkspaceRootRegistry(
      path.join(home, ".promptlab"),
      home,
    );
    const picker = new LocalWorkspaceDirectoryPicker(() => home);
    let runtimePromise: Promise<LocalWorkspaceRuntime> | null = null;
    const getRuntime = () => {
      runtimePromise ??= registry
        .list()
        .then((roots) =>
          createLocalWorkspaceRuntime(
            undefined,
            undefined,
            { enabled: false },
            roots,
          ),
        );
      return runtimePromise;
    };
    const invalidateRuntime = () => {
      runtimePromise = null;
    };
    const rootHandlers = createLocalWorkspaceRootHandlers({
      registry,
      picker,
      getRuntime,
      projectExists: async () => true,
      invalidateRuntime,
    });
    const pathPrefix = "/api/projects/" + PROJECT_ID + "/workspace";

    const firstListing = await rootHandlers.pickerListing(
      localRequest(pathPrefix + "/roots/picker"),
      PROJECT_ID,
    );
    const firstPayload = await firstListing.json();
    const entries = (
      firstPayload as { directories: Array<{ name: string; token: string }> }
    ).directories;
    const folderToken = entries.find(
      (entry) => entry.name === "FP_PBKK",
    )?.token;
    expect(firstListing.status).toBe(200);
    expect(folderToken).toBeTruthy();

    const selectedListing = await rootHandlers.pickerListing(
      localRequest(
        pathPrefix + "/roots/picker?token=" + encodeURIComponent(folderToken!),
      ),
      PROJECT_ID,
    );
    const selectedPayload = (await selectedListing.json()) as {
      currentToken: string;
    };
    const registration = await rootHandlers.register(
      localRequest(pathPrefix + "/roots", "POST", {
        selectionToken: selectedPayload.currentToken,
      }),
      PROJECT_ID,
    );
    const registrationPayload = (await registration.json()) as {
      root: { rootId: string; displayName: string };
    };
    expect(registration.status).toBe(201);
    expect(registrationPayload.root.displayName).toBe("FP_PBKK");
    expect(JSON.stringify(registrationPayload)).not.toContain(projectRoot);

    const rootsResponse = await rootHandlers.list(
      localRequest(pathPrefix + "/roots"),
      PROJECT_ID,
    );
    await expect(rootsResponse.json()).resolves.toMatchObject({
      roots: [
        {
          rootId: registrationPayload.root.rootId,
          displayName: "FP_PBKK",
          source: "registered",
          available: true,
        },
      ],
      canChooseDirectory: true,
    });

    const workspaceHandlers = createLocalWorkspaceRouteHandlers({ getRuntime });
    const approval = await workspaceHandlers.approve(
      localRequest(pathPrefix + "/grants", "POST", {
        approval: "read_only_project_root",
        rootId: registrationPayload.root.rootId,
      }),
      PROJECT_ID,
    );
    const grantPayload = (await approval.json()) as {
      grantId: string;
      rootId: string;
      access: string;
    };
    expect(approval.status).toBe(201);
    expect(grantPayload).toMatchObject({
      rootId: registrationPayload.root.rootId,
      access: "read_only",
    });

    const listed = await workspaceHandlers.list(
      localRequest(
        pathPrefix + "/grants/" + grantPayload.grantId + "/list?path=docs",
      ),
      PROJECT_ID,
      grantPayload.grantId,
    );
    await expect(listed.json()).resolves.toMatchObject({
      path: "docs",
      entries: [{ name: "readme.md", kind: "file" }],
    });

    const revoked = await rootHandlers.revoke(
      localRequest(pathPrefix + "/roots", "DELETE", {
        rootId: registrationPayload.root.rootId,
      }),
      PROJECT_ID,
    );
    await expect(revoked.json()).resolves.toMatchObject({ revoked: true });
    invalidateRuntime();
    const afterRevoke = await workspaceHandlers.list(
      localRequest(pathPrefix + "/grants/" + grantPayload.grantId + "/list"),
      PROJECT_ID,
      grantPayload.grantId,
    );
    expect(afterRevoke.status).toBe(503);
  });

  it("requires same-origin loopback trust and never accepts a browser-supplied root path", async () => {
    const home = await temporaryDirectory();
    const registry = new LocalWorkspaceRootRegistry(
      path.join(home, ".promptlab"),
      home,
    );
    const handlers = createLocalWorkspaceRootHandlers({
      registry,
      picker: new LocalWorkspaceDirectoryPicker(() => home),
      getRuntime: async () => ({
        kind: "unavailable",
        reason: "not_configured",
      }),
      projectExists: async () => true,
    });
    const pathPrefix = "/api/projects/" + PROJECT_ID + "/workspace/roots";

    const crossOrigin = await handlers.list(
      localRequest(pathPrefix, "GET", undefined, "https://attacker.example"),
      PROJECT_ID,
    );
    expect(crossOrigin.status).toBe(403);

    const arbitraryPath = await handlers.register(
      localRequest(pathPrefix, "POST", { rootPath: home }),
      PROJECT_ID,
    );
    expect(arbitraryPath.status).toBe(400);
    expect(await registry.list(PROJECT_ID)).toEqual([]);
  });
});

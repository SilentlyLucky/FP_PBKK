import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProviderSmokeLedger,
  MAX_INFERENCE_CALLS_PER_PROVIDER,
  resolveDefaultProviderSmokeLedgerPath,
} from "./ledger.mjs";
import {
  resolveDefaultProviderSmokeLedgerPath as resolvePersistedLedgerPath,
  resolveProviderVerificationCampaignLedgerPath,
  DEFAULT_PROVIDER_VERIFICATION_CAMPAIGN_BUDGET,
} from "../../packages/providers/src/provider-smoke-ledger.ts";

const directories: string[] = [];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CAMPAIGN_ID = "live-journey-2026-10-17-7c3f8d2e";

async function makeLedger(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "promptlab-ledger-test-"));
  directories.push(directory);
  const path = join(directory, "ledger.json");
  await writeFile(
    path,
    `${JSON.stringify(
      {
        session: "foundation-provider-spike-2026-10-11",
        maxInferenceCallsPerProvider: MAX_INFERENCE_CALLS_PER_PROVIDER,
        providers: {
          campus_gateway: {
            reservedCalls: 0,
            lastOutcome: "not_attempted",
            requestedModel: null,
            responseModel: null,
            usage: "unknown",
            capabilitiesObserved: [],
          },
          codex_app_server: {
            reservedCalls: 0,
            lastOutcome: "not_attempted",
            requestedModel: null,
            responseModel: null,
            usage: "unknown",
            capabilitiesObserved: [],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("provider smoke call ledger", () => {
  it("resolves the same canonical ledger from root and web working directories", () => {
    const expectedPath = join(
      projectRoot,
      "docs",
      "PROVIDER_SMOKE_LEDGER.json",
    );

    expect(resolveDefaultProviderSmokeLedgerPath(projectRoot)).toBe(
      expectedPath,
    );
    expect(
      resolveDefaultProviderSmokeLedgerPath(join(projectRoot, "apps", "web")),
    ).toBe(expectedPath);
  });

  it("resolves a campaign to a deterministic file under the canonical project root", () => {
    const expectedPath = join(
      projectRoot,
      "docs",
      "provider-verification-campaigns",
      `${CAMPAIGN_ID}.json`,
    );

    expect(
      resolveProviderVerificationCampaignLedgerPath(CAMPAIGN_ID, projectRoot),
    ).toBe(expectedPath);
    expect(
      resolveProviderVerificationCampaignLedgerPath(
        CAMPAIGN_ID,
        join(projectRoot, "apps", "web"),
      ),
    ).toBe(expectedPath);
  });

  it("uses an explicitly configured absolute path for the shared persisted ledger", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-ledger-configured-path-"),
    );
    directories.push(directory);
    const ledgerPath = join(directory, "PROVIDER_SMOKE_LEDGER.json");
    await writeFile(ledgerPath, "{}\n");
    const environment = { PROMPTLAB_PROVIDER_LEDGER_PATH: ledgerPath };

    expect(resolvePersistedLedgerPath(projectRoot, environment)).toBe(
      ledgerPath,
    );
    expect(
      resolveProviderVerificationCampaignLedgerPath(
        CAMPAIGN_ID,
        projectRoot,
        environment,
      ),
    ).toBe(
      join(directory, "provider-verification-campaigns", `${CAMPAIGN_ID}.json`),
    );
  });

  it("fails closed for relative or missing configured ledger paths", async () => {
    expect(() =>
      resolvePersistedLedgerPath(projectRoot, {
        PROMPTLAB_PROVIDER_LEDGER_PATH: "data/provider-ledger.json",
      }),
    ).toThrow("must be an absolute path");

    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-ledger-configured-missing-"),
    );
    directories.push(directory);
    expect(() =>
      resolvePersistedLedgerPath(projectRoot, {
        PROMPTLAB_PROVIDER_LEDGER_PATH: join(directory, "missing.json"),
      }),
    ).toThrow("is missing");
  });

  it("rejects path-like or nonconforming campaign IDs before path resolution", () => {
    for (const campaignId of [
      "../" + CAMPAIGN_ID,
      CAMPAIGN_ID + "/x",
      CAMPAIGN_ID + "\\x",
      CAMPAIGN_ID.toUpperCase(),
      "short",
      "a".repeat(33),
      ".".repeat(32),
    ]) {
      expect(() =>
        resolveProviderVerificationCampaignLedgerPath(campaignId, projectRoot),
      ).toThrow("must be exactly 32 lowercase");
    }
  });

  it("reads a validated snapshot without modifying the ledger", async () => {
    const path = await makeLedger();
    const ledger = createProviderSmokeLedger(path);
    const before = await readFile(path, "utf8");

    const snapshot = await ledger.getSmokeLedgerSnapshot();

    expect(snapshot.providers.campus_gateway.reservedCalls).toBe(0);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("fails closed when the owning project has no canonical ledger", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-ledger-project-missing-"),
    );
    directories.push(directory);
    const nestedDirectory = join(directory, "apps", "web");
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "promptlab-foundation" }),
    );

    expect(() =>
      resolveDefaultProviderSmokeLedgerPath(nestedDirectory),
    ).toThrow("Canonical provider call ledger is missing");
  });

  it("enforces the code-owned cap of five reservations", async () => {
    const path = await makeLedger();
    const ledger = createProviderSmokeLedger(path);

    for (
      let expectedCall = 1;
      expectedCall <= MAX_INFERENCE_CALLS_PER_PROVIDER;
      expectedCall += 1
    ) {
      await expect(ledger.reserveInferenceCall("campus_gateway")).resolves.toBe(
        expectedCall,
      );
    }
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "Inference call cap reached",
    );
    await ledger.recordInferenceOutcome("campus_gateway", {
      outcome: "blocked_budget_exhausted",
    });
    expect(
      JSON.parse(await readFile(path, "utf8")).providers.campus_gateway,
    ).toMatchObject({
      reservedCalls: MAX_INFERENCE_CALLS_PER_PROVIDER,
      lastOutcome: "blocked_budget_exhausted",
    });
  });

  it("fails closed when the ledger is missing without creating a new one", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-ledger-missing-"),
    );
    directories.push(directory);
    const path = join(directory, "missing.json");
    const ledger = createProviderSmokeLedger(path);

    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "ledger is missing",
    );
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records a no-project block without reserving a provider call", async () => {
    const path = await makeLedger();
    const ledger = createProviderSmokeLedger(path);

    await ledger.recordInferenceOutcome("campus_gateway", {
      outcome: "blocked_no_active_projects",
    });
    expect(
      JSON.parse(await readFile(path, "utf8")).providers.campus_gateway,
    ).toMatchObject({
      reservedCalls: 0,
      lastOutcome: "blocked_no_active_projects",
    });
  });

  it("fails closed for corrupt JSON and invalid full-shape records", async () => {
    const path = await makeLedger();
    const ledger = createProviderSmokeLedger(path);
    const validLedgerText = await readFile(path, "utf8");

    await writeFile(path, "{broken json");
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "corrupt JSON",
    );
    expect(await readFile(path, "utf8")).toBe("{broken json");
    const validLedger = JSON.parse(validLedgerText);
    validLedger.providers.campus_gateway.reservedCalls = 2.5;
    await writeFile(path, JSON.stringify(validLedger));
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "values are invalid for campus_gateway",
    );
    validLedger.providers.campus_gateway.reservedCalls =
      MAX_INFERENCE_CALLS_PER_PROVIDER + 1;
    await writeFile(path, JSON.stringify(validLedger));
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "values are invalid for campus_gateway",
    );
    validLedger.providers.campus_gateway.reservedCalls = 0;
    delete validLedger.providers.campus_gateway.responseModel;
    await writeFile(path, JSON.stringify(validLedger));
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "invalid campus_gateway entry shape",
    );
    await writeFile(
      path,
      JSON.stringify({
        session: "foundation-provider-spike-2026-10-11",
        maxInferenceCallsPerProvider: MAX_INFERENCE_CALLS_PER_PROVIDER,
        providers: {
          campus_gateway: {
            reservedCalls: MAX_INFERENCE_CALLS_PER_PROVIDER + 1,
          },
          codex_app_server: {},
        },
      }),
    );
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "invalid campus_gateway entry shape",
    );
  });

  it("reserves no more than five calls under concurrent requests", async () => {
    const path = await makeLedger();
    const ledger = createProviderSmokeLedger(path);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ledger.reserveInferenceCall("codex_app_server"),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(MAX_INFERENCE_CALLS_PER_PROVIDER);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(8 - MAX_INFERENCE_CALLS_PER_PROVIDER);
    expect(
      JSON.parse(await readFile(path, "utf8")).providers.codex_app_server,
    ).toMatchObject({ reservedCalls: MAX_INFERENCE_CALLS_PER_PROVIDER });
  });

  it("persists the named campaign cap across recreated ledger instances", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-ledger-test-"),
    );
    directories.push(directory);
    const path = join(directory, `${CAMPAIGN_ID}.json`);
    const firstRun = createProviderSmokeLedger(path, CAMPAIGN_ID);

    await expect(firstRun.reserveInferenceCall("campus_gateway")).resolves.toBe(
      1,
    );

    const restartedRun = createProviderSmokeLedger(path, CAMPAIGN_ID);
    for (
      let expectedCall = 2;
      expectedCall <= MAX_INFERENCE_CALLS_PER_PROVIDER;
      expectedCall += 1
    ) {
      await expect(
        restartedRun.reserveInferenceCall("campus_gateway"),
      ).resolves.toBe(expectedCall);
    }
    await expect(
      createProviderSmokeLedger(path, CAMPAIGN_ID).reserveInferenceCall(
        "campus_gateway",
      ),
    ).rejects.toThrow("Inference call cap reached");

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      campaignId: string;
      providers: Record<string, { reservedCalls: number }>;
    };
    expect(persisted).toMatchObject({
      campaignId: CAMPAIGN_ID,
      providers: {
        campus_gateway: {
          reservedCalls: MAX_INFERENCE_CALLS_PER_PROVIDER,
        },
      },
    });
  });

  it("enforces finite per-provider campaign budgets and counts reconciled calls", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-provider-budget-test-"),
    );
    directories.push(directory);
    const path = join(directory, `${CAMPAIGN_ID}.json`);
    const budget = { campus_gateway: 2, codex_app_server: 4 } as const;
    const ledger = createProviderSmokeLedger(path, CAMPAIGN_ID, budget);
    await ledger.getSmokeLedgerSnapshot();

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<
        string,
        { reservedCalls: number; reconciledCalls?: number }
      >;
    };
    persisted.providers.codex_app_server!.reconciledCalls = 1;
    await writeFile(path, JSON.stringify(persisted, null, 2) + "\n");

    await expect(ledger.reserveInferenceCall("campus_gateway")).resolves.toBe(
      1,
    );
    await expect(ledger.reserveInferenceCall("campus_gateway")).resolves.toBe(
      2,
    );
    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "cap reached for campus_gateway at 2",
    );

    await expect(ledger.reserveInferenceCall("codex_app_server")).resolves.toBe(
      1,
    );
    await expect(ledger.reserveInferenceCall("codex_app_server")).resolves.toBe(
      2,
    );
    await expect(ledger.reserveInferenceCall("codex_app_server")).resolves.toBe(
      3,
    );
    await expect(
      ledger.reserveInferenceCall("codex_app_server"),
    ).rejects.toThrow("cap reached for codex_app_server at 4");
  });

  it("allows bounded campaign ceilings above the legacy two-call smoke cap", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-expanded-budget-test-"),
    );
    directories.push(directory);
    const path = join(directory, `${CAMPAIGN_ID}.json`);
    const ledger = createProviderSmokeLedger(path, CAMPAIGN_ID, {
      campus_gateway: 18,
      codex_app_server: 21,
    });

    await expect(ledger.getSmokeLedgerSnapshot()).resolves.toMatchObject({
      maxInferenceCallsByProvider: {
        campus_gateway: 18,
        codex_app_server: 21,
      },
    });
  });

  it("does not recreate a campaign ledger after its initialization record exists", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-no-reset-test-"),
    );
    directories.push(directory);
    const path = join(directory, "campaign.json");
    const ledger = createProviderSmokeLedger(path, CAMPAIGN_ID);
    await ledger.reserveInferenceCall("campus_gateway");
    await rm(path);

    await expect(ledger.reserveInferenceCall("campus_gateway")).rejects.toThrow(
      "missing after initialization; refusing to reset it",
    );
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a ledger copied from another campaign without changing its bytes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-identity-test-"),
    );
    directories.push(directory);
    const path = join(directory, "campaign.json");
    const originalCampaign = createProviderSmokeLedger(path, CAMPAIGN_ID);
    await originalCampaign.reserveInferenceCall("codex_app_server");
    const before = await readFile(path, "utf8");
    const differentCampaign = "live-journey-2026-10-17-5e9d2a41";

    await expect(
      createProviderSmokeLedger(path, differentCampaign).reserveInferenceCall(
        "codex_app_server",
      ),
    ).rejects.toThrow("campaign metadata is invalid");
    expect(await readFile(path, "utf8")).toBe(before);

    await writeFile(path, "{broken campaign json");
    await expect(
      originalCampaign.reserveInferenceCall("codex_app_server"),
    ).rejects.toThrow("corrupt JSON");
    expect(await readFile(path, "utf8")).toBe("{broken campaign json");
  });

  it("serializes concurrent reservations for one campaign", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-lock-test-"),
    );
    directories.push(directory);
    const path = join(directory, "campaign.json");
    const ledger = createProviderSmokeLedger(path, CAMPAIGN_ID);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ledger.reserveInferenceCall("codex_app_server"),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(MAX_INFERENCE_CALLS_PER_PROVIDER);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(8 - MAX_INFERENCE_CALLS_PER_PROVIDER);
    expect(
      JSON.parse(await readFile(path, "utf8")).providers.codex_app_server,
    ).toMatchObject({ reservedCalls: MAX_INFERENCE_CALLS_PER_PROVIDER });
  });

  it("keeps the historical ledger untouched and configures the backend singleton at import", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-campaign-singleton-test-"),
    );
    directories.push(directory);
    const docsDirectory = join(directory, "docs");
    await mkdir(docsDirectory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "promptlab-foundation" }),
    );
    const historicalPath = join(docsDirectory, "PROVIDER_SMOKE_LEDGER.json");
    const historicalBytes = await readFile(
      join(projectRoot, "docs", "PROVIDER_SMOKE_LEDGER.json"),
      "utf8",
    );
    await writeFile(historicalPath, historicalBytes);
    const previousDirectory = process.cwd();
    const previousCampaign =
      process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN;

    try {
      process.chdir(directory);
      delete process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN;
      vi.resetModules();
      const legacyModule = await import("./ledger.mjs");
      const legacySnapshot = await legacyModule.getSmokeLedgerSnapshot();
      expect("session" in legacySnapshot && legacySnapshot.session).toBe(
        "foundation-provider-spike-2026-10-11",
      );
      expect(await readFile(historicalPath, "utf8")).toBe(historicalBytes);

      process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN = `../${CAMPAIGN_ID}`;
      vi.resetModules();
      const invalidCampaignModule = await import("./ledger.mjs");
      await expect(
        invalidCampaignModule.reserveInferenceCall("campus_gateway"),
      ).rejects.toThrow("must be exactly 32 lowercase");
      expect(await readFile(historicalPath, "utf8")).toBe(historicalBytes);
      await expect(
        readdir(join(docsDirectory, "provider-verification-campaigns")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN = CAMPAIGN_ID;
      vi.resetModules();
      const campaignModule = await import("./ledger.mjs");
      await campaignModule.recordInferenceOutcome("campus_gateway", {
        outcome: "blocked_no_active_projects",
      });
      const firstSnapshot = await campaignModule.getSmokeLedgerSnapshot();
      expect(firstSnapshot).toMatchObject({
        campaignId: CAMPAIGN_ID,
        maxInferenceCallsByProvider:
          DEFAULT_PROVIDER_VERIFICATION_CAMPAIGN_BUDGET,
      });
      expect(await campaignModule.reserveInferenceCall("campus_gateway")).toBe(
        1,
      );
      expect(await readFile(historicalPath, "utf8")).toBe(historicalBytes);

      vi.resetModules();
      const restartedModule = await import("./ledger.mjs");
      const restartedSnapshot = await restartedModule.getSmokeLedgerSnapshot();
      expect(
        "campaignId" in restartedSnapshot && restartedSnapshot.campaignId,
      ).toBe(CAMPAIGN_ID);
      expect(restartedSnapshot.providers.campus_gateway.reservedCalls).toBe(1);
    } finally {
      process.chdir(previousDirectory);
      if (previousCampaign === undefined) {
        delete process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN;
      } else {
        process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN = previousCampaign;
      }
      vi.resetModules();
    }
  });
});

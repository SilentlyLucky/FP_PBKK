"use client";

import { CheckCircle2, CircleHelp, Shield } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notifyProviderStatusRefresh } from "@/lib/provider-status-refresh";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  canVerifyCodex,
  codexLoginPollFailure,
  isSelectedCodexModelVerified,
  type ProjectPrerequisite,
} from "@/lib/provider-settings-guards";
import type { ProviderConnectionState } from "@promptlab/contracts";

const labels: Record<string, string> = {
  streamText: "Teks streaming",
  reportedUsage: "Usage provider",
  cacheReadReporting: "Cache read",
  cacheWriteReporting: "Cache write",
  cancellation: "Batal lokal",
  remoteCancellation: "Batal remote",
  structuredOutput: "Structured output",
  toolCalls: "Tool calls provider",
  quotaReporting: "Laporan kuota",
};

const CODEX_LOGIN_POLL_INTERVAL_MS = 2_000;
const CODEX_LOGIN_MAX_POLL_FAILURES = 3;

type CampaignProvider = "campus_gateway" | "codex_app_server";
interface CapabilityCampaignResult {
  provider: CampaignProvider;
  status: "completed" | "partial" | "blocked";
  plannedInferenceCalls: number;
  attemptedInferenceCalls: number;
  reason: string;
  capabilities: ProviderConnectionState["capabilities"];
}

function capabilityLabel(status: string): string {
  if (status === "supported") return "Teramati";
  if (status === "unsupported") return "Tidak didukung";
  if (status === "policy_restricted") return "Dibatasi kebijakan";
  if (status === "not_observed") return "Tidak teramati";
  if (status === "not_exposed") return "Tidak diekspos";
  if (status === "failed") return "Probe gagal";
  if (status === "blocked") return "Terblokir";
  return "Belum diketahui";
}

function statusLabel(status: ProviderConnectionState["status"]): string {
  switch (status) {
    case "verified":
      return "Terverifikasi";
    case "configured_unverified":
      return "Belum terverifikasi";
    case "unavailable":
      return "Tidak tersedia";
    case "blocked":
      return "Diblokir";
    default:
      return "Belum diketahui";
  }
}

function roleLabel(role: ProviderConnectionState["role"]): string {
  switch (role) {
    case "optimizer":
      return "Optimizer";
    case "target":
      return "Model target";
    case "evaluator":
      return "Evaluator";
    case "auxiliary":
      return "Layanan pendukung";
  }
}

interface ProviderApiResult {
  providers?: ProviderConnectionState[];
  codexModels?: Array<{ id: string; displayName: string }>;
  projectPrerequisite?: ProjectPrerequisite;
  message?: string;
  outcome?: string;
  campaign?: CapabilityCampaignResult;
  login?: {
    loginId: string;
    verificationUrl: string;
    userCode: string;
    status: "pending" | "succeeded" | "failed" | "expired";
  };
}

export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderConnectionState[]>([]);
  const [projectPrerequisite, setProjectPrerequisite] =
    useState<NonNullable<ProviderApiResult["projectPrerequisite"]>>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [verificationMessage, setVerificationMessage] = useState<string | null>(
    null,
  );
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [codexModels, setCodexModels] = useState<
    Array<{ id: string; displayName: string }>
  >([]);
  const [selectedCodexModel, setSelectedCodexModel] = useState("");
  const [codexLogin, setCodexLogin] =
    useState<ProviderApiResult["login"]>(undefined);
  const [codexAction, setCodexAction] = useState<"login" | "verify" | null>(
    null,
  );
  const [codexMessage, setCodexMessage] = useState<string | null>(null);
  const [codexMessageFailed, setCodexMessageFailed] = useState(false);
  const [capabilityCampaigns, setCapabilityCampaigns] = useState<
    Partial<Record<CampaignProvider, CapabilityCampaignResult>>
  >({});
  const [campaignAction, setCampaignAction] =
    useState<CampaignProvider | null>(null);
  const [campaignMessage, setCampaignMessage] = useState<{
    provider: CampaignProvider;
    text: string;
    failed: boolean;
  } | null>(null);

  const applyProviderResult = useCallback((result: ProviderApiResult) => {
    setProviders(result.providers ?? []);
    if (result.projectPrerequisite)
      setProjectPrerequisite(result.projectPrerequisite);
    const models = result.codexModels ?? [];
    setCodexModels(models);
    setSelectedCodexModel((current) => {
      if (models.some((model) => model.id === current)) return current;
      const verifiedModel = result.providers?.find(
        (provider) => provider.provider === "codex_app_server",
      )?.requestedModel;
      return models.some((model) => model.id === verifiedModel)
        ? (verifiedModel ?? "")
        : (models[0]?.id ?? "");
    });
  }, []);

  const loadProviders = useCallback(async () => {
    const response = await fetch("/api/providers", { cache: "no-store" });
    const result = (await response.json()) as ProviderApiResult;
    if (!response.ok) throw new Error("Status provider tidak tersedia.");
    applyProviderResult(result);
  }, [applyProviderResult]);

  const codexTarget = providers.find(
    (provider) =>
      provider.provider === "codex_app_server" && provider.role === "target",
  );
  const selectedCodexModelVerified = isSelectedCodexModelVerified(
    codexTarget,
    selectedCodexModel,
  );
  const codexVerificationAvailable =
    !selectedCodexModelVerified &&
    canVerifyCodex({
      projectPrerequisite,
      loginPending: codexLogin?.status === "pending",
      selectedModelId: selectedCodexModel,
      availableModelIds: codexModels.map((model) => model.id),
      providerAvailable: providers.some(
        (provider) =>
          provider.provider === "codex_app_server" &&
          provider.status !== "unavailable",
      ),
    });

  useEffect(() => {
    let active = true;
    fetch("/api/providers", { cache: "no-store" })
      .then(async (response) => {
        const result = (await response.json()) as ProviderApiResult;
        if (!response.ok) throw new Error("Status provider tidak tersedia.");
        if (active) applyProviderResult(result);
      })
      .catch(() => {
        if (active) setError("Status provider tidak tersedia.");
      });
    return () => {
      active = false;
    };
  }, [applyProviderResult]);

  const pendingLoginId =
    codexLogin?.status === "pending" ? codexLogin.loginId : null;
  useEffect(() => {
    if (!pendingLoginId) return;
    let active = true;
    let timer: number | undefined;
    let consecutiveFailures = 0;

    const finish = (
      status: "succeeded" | "failed" | "expired",
      message: string,
    ) => {
      if (!active) return;
      active = false;
      setCodexLogin((current) =>
        current?.loginId === pendingLoginId ? { ...current, status } : current,
      );
      setCodexMessage(message);
      setCodexMessageFailed(status !== "succeeded");
      if (status === "succeeded") {
        void loadProviders().catch(() =>
          setError("Status provider tidak tersedia."),
        );
      } else {
        // A failed or lost login must not leave models from an older session
        // enabling verification.
        setCodexModels([]);
        setSelectedCodexModel("");
      }
      notifyProviderStatusRefresh();
    };

    const retryOrFinish = () => {
      if (!active) return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= CODEX_LOGIN_MAX_POLL_FAILURES) {
        finish(
          "failed",
          "Status login Codex tidak dapat diperiksa. Mulai login kembali untuk mencoba lagi.",
        );
        return;
      }
      timer = window.setTimeout(
        () => void poll(),
        CODEX_LOGIN_POLL_INTERVAL_MS,
      );
    };

    async function poll() {
      try {
        const response = await fetch("/api/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "codex-login-status",
            loginId: pendingLoginId,
          }),
        });
        if (!active) return;
        const httpFailure = codexLoginPollFailure(response.status);
        if (httpFailure === "expired") {
          finish(
            "expired",
            "Sesi login Codex berakhir. Mulai login kembali untuk mencoba lagi.",
          );
          return;
        }
        if (httpFailure === "retry") {
          retryOrFinish();
          return;
        }
        if (httpFailure === "failed") {
          finish(
            "failed",
            "Status login Codex tidak dapat diperbarui. Mulai login kembali untuk mencoba lagi.",
          );
          return;
        }

        const result = (await response.json()) as ProviderApiResult;
        if (!active) return;
        const resultFailure = codexLoginPollFailure(
          response.status,
          result.outcome,
        );
        if (resultFailure === "expired") {
          finish(
            "expired",
            "Sesi login Codex berakhir. Mulai login kembali untuk mencoba lagi.",
          );
          return;
        }
        if (resultFailure === "retry") {
          retryOrFinish();
          return;
        }
        if (resultFailure === "failed") {
          finish(
            "failed",
            "Status login Codex tidak dapat diperbarui. Mulai login kembali untuk mencoba lagi.",
          );
          return;
        }
        if (!result.login || result.login.loginId !== pendingLoginId) {
          retryOrFinish();
          return;
        }

        switch (result.login.status) {
          case "pending":
            consecutiveFailures = 0;
            setCodexLogin(result.login);
            timer = window.setTimeout(
              () => void poll(),
              CODEX_LOGIN_POLL_INTERVAL_MS,
            );
            return;
          case "succeeded":
            finish(
              "succeeded",
              "Login Codex berhasil. Pilih model lalu verifikasi target.",
            );
            return;
          case "expired":
            finish(
              "expired",
              "Login Codex kedaluwarsa. Mulai login kembali untuk mencoba lagi.",
            );
            return;
          case "failed":
          default:
            finish(
              "failed",
              "Login Codex gagal. Mulai login kembali untuk mencoba lagi.",
            );
        }
      } catch {
        retryOrFinish();
      }
    }

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pendingLoginId, loadProviders]);

  async function beginCodexLogin() {
    setCodexAction("login");
    setCodexMessage(null);
    setCodexMessageFailed(false);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "codex-login-start" }),
      });
      const result = (await response.json()) as ProviderApiResult;
      if (!response.ok || !result.login)
        throw new Error(result.message ?? "Login Codex tidak dapat dimulai.");
      setCodexLogin(result.login);
      setCodexMessage(result.message ?? "Ikuti login resmi Codex.");
    } catch (cause) {
      setCodexMessage(
        cause instanceof Error
          ? cause.message
          : "Login Codex tidak dapat dimulai.",
      );
      setCodexMessageFailed(true);
    } finally {
      setCodexAction(null);
    }
  }

  async function verifyCodexTarget() {
    if (selectedCodexModelVerified) {
      setCodexMessage(
        "Model ini sudah terverifikasi untuk konfigurasi aktif. Tidak perlu mengirim panggilan verifikasi baru.",
      );
      setCodexMessageFailed(false);
      return;
    }
    if (!codexVerificationAvailable) return;
    setCodexAction("verify");
    setCapabilityCampaigns((current) => {
      const next = { ...current };
      delete next.codex_app_server;
      return next;
    });
    setCodexMessage(null);
    setCodexMessageFailed(false);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "codex-verify",
          model: selectedCodexModel,
        }),
      });
      const result = (await response.json()) as ProviderApiResult;
      if (result.providers || result.codexModels) applyProviderResult(result);
      if (result.outcome === "no_active_projects")
        setProjectPrerequisite("missing");
      setCodexMessage(
        result.message ??
          (response.ok
            ? "Verifikasi Codex selesai."
            : "Verifikasi Codex tidak berhasil."),
      );
      setCodexMessageFailed(!response.ok || result.outcome !== "verified");
      if (!result.providers) await loadProviders();
    } catch (cause) {
      setCodexMessage(
        cause instanceof Error
          ? cause.message
          : "Verifikasi Codex tidak dapat dihubungi.",
      );
      setCodexMessageFailed(true);
    } finally {
      setCodexAction(null);
      notifyProviderStatusRefresh();
    }
  }

  async function verifyCampusConnection() {
    if (projectPrerequisite !== "satisfied") return;
    setVerifying(true);
    setCapabilityCampaigns((current) => {
      const next = { ...current };
      delete next.campus_gateway;
      return next;
    });
    setVerificationMessage(null);
    setVerificationFailed(false);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as ProviderApiResult;
      if (result.providers) setProviders(result.providers);
      if (result.outcome === "no_active_projects")
        setProjectPrerequisite("missing");
      setVerificationFailed(!response.ok || result.outcome !== "verified");
      setVerificationMessage(
        result.message ??
          (response.ok
            ? "Verifikasi selesai."
            : "Verifikasi tidak berhasil. Detail sensitif tidak ditampilkan."),
      );
      if (!result.providers) await loadProviders();
    } catch {
      setVerificationFailed(true);
      setVerificationMessage(
        "Verifikasi tidak dapat dihubungi. Detail server tidak ditampilkan.",
      );
      try {
        await loadProviders();
      } catch {
        // Keep the last status visible when refreshing also fails.
      }
    } finally {
      setVerifying(false);
      notifyProviderStatusRefresh();
    }
  }

  async function runCapabilityCampaign(provider: CampaignProvider) {
    setCampaignAction(provider);
    setCampaignMessage(null);
    try {
      const body =
        provider === "campus_gateway"
          ? { action: "campus-capability-campaign" }
          : {
              action: "codex-capability-campaign",
              model: selectedCodexModel,
            };
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ProviderApiResult;
      if (result.providers) applyProviderResult(result);
      if (result.campaign) {
        setCapabilityCampaigns((current) => ({
          ...current,
          [provider]: result.campaign,
        }));
        setCampaignMessage({
          provider,
          text: `${result.message ?? result.campaign.reason} (${result.campaign.attemptedInferenceCalls}/${result.campaign.plannedInferenceCalls} panggilan dicoba.)`,
          failed: !response.ok || result.campaign.status !== "completed",
        });
      } else {
        setCampaignMessage({
          provider,
          text: result.message ?? "Receipt kampanye tidak tersedia.",
          failed: true,
        });
      }
      if (!result.providers) await loadProviders();
    } catch (cause) {
      setCampaignMessage({
        provider,
        text:
          cause instanceof Error
            ? cause.message
            : "Kampanye tidak dapat dihubungi.",
        failed: true,
      });
      try {
        await loadProviders();
      } catch {
        // Keep the last provider state visible if the refresh also fails.
      }
    } finally {
      setCampaignAction(null);
      notifyProviderStatusRefresh();
    }
  }

  if (error)
    return (
      <p className="error-message" role="alert">
        {error}
      </p>
    );

  const campusConfigured = providers.some(
    (provider) =>
      provider.provider === "campus_gateway" &&
      provider.status !== "unavailable",
  );
  const codexCampaignAvailable =
    projectPrerequisite === "satisfied" &&
    Boolean(selectedCodexModel) &&
    codexModels.some((model) => model.id === selectedCodexModel) &&
    providers.some(
      (provider) =>
        provider.provider === "codex_app_server" &&
        provider.status !== "unavailable",
    ) &&
    codexLogin?.status !== "pending";

  return (
    <section aria-label="Status provider">
      <div>
        <Button
          type="button"
          onClick={verifyCampusConnection}
          disabled={
            verifying ||
            campaignAction !== null ||
            !campusConfigured ||
            projectPrerequisite !== "satisfied"
          }
          aria-label="Verifikasi koneksi gateway kampus"
        >
          {verifying ? "Memverifikasi…" : "Verifikasi koneksi kampus"}
        </Button>
        {projectPrerequisite === "missing" ? (
          <p className="helper" role="status">
            Verifikasi provider memerlukan proyek aktif untuk menyimpan bukti.{" "}
            <Link className="knowledge-link" href="/overview">
              Buat proyek di Overview
            </Link>
            .
          </p>
        ) : projectPrerequisite === "unknown" ? (
          <p className="helper" role="status">
            Status proyek tidak tersedia. Verifikasi provider dinonaktifkan
            sampai statusnya dapat diperiksa.
          </p>
        ) : null}
        <p
          className="helper"
          role={
            verificationMessage
              ? verificationFailed
                ? "alert"
                : "status"
              : undefined
          }
          aria-live="polite"
        >
          {verificationMessage ??
            "Tindakan ini mengirim satu request chat kecil. Tidak ada retry otomatis."}
        </p>
      </div>
      <div className="provider-grid">
        {providers.map((provider) => (
          <Card key={`${provider.provider}:${provider.role}`}>
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>
                    {provider.provider === "campus_gateway"
                      ? "Gateway kampus"
                      : provider.provider === "codex_app_server"
                        ? "Codex app-server"
                        : provider.provider}
                  </CardTitle>
                  <CardDescription>
                    {provider.endpointLabel ?? "Endpoint tidak tersedia"}
                  </CardDescription>
                </div>
                <Badge
                  variant={
                    provider.status === "verified"
                      ? "success"
                      : provider.status === "configured_unverified"
                        ? "warning"
                        : "muted"
                  }
                >
                  {statusLabel(provider.status)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="provider-facts">
                <div>
                  <span>Peran</span>
                  <span>{roleLabel(provider.role)}</span>
                </div>
                <div>
                  <span>Model diminta</span>
                  <span className="mono">
                    {provider.requestedModel ?? "Tidak dikonfigurasi"}
                  </span>
                </div>
                <div>
                  <span>Model respons terakhir</span>
                  <span className="mono">
                    {provider.responseModel ?? "Tidak tersedia"}
                  </span>
                </div>
                <div>
                  <span>Terakhir diperiksa</span>
                  <span>{provider.checkedAt ?? "Belum diperiksa"}</span>
                </div>
              </div>
              <p className="helper provider-reason">
                {provider.reason ??
                  "Capability tetap unknown sampai diuji dengan bukti runtime."}
              </p>
              {provider.provider === "codex_app_server" ? (
                <div className="stack">
                  {codexModels.length ? (
                    <div className="field">
                      <label htmlFor="codex-target-model">
                        Model target Codex
                      </label>
                      <select
                        id="codex-target-model"
                        className="input"
                        value={selectedCodexModel}
                        onChange={(event) =>
                          setSelectedCodexModel(event.target.value)
                        }
                        disabled={codexAction !== null}
                      >
                        {codexModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName} ({model.id})
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {codexLogin?.status === "pending" ? (
                    <div className="helper" role="status">
                      <p>Buka login ChatGPT resmi, lalu masukkan kode ini:</p>
                      <p className="mono" aria-label="Kode login Codex">
                        {codexLogin.userCode}
                      </p>
                      <a
                        className="knowledge-link"
                        href={codexLogin.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Buka halaman login Codex
                      </a>
                    </div>
                  ) : null}
                  <div className="form-row">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={beginCodexLogin}
                      disabled={
                        codexAction !== null || codexLogin?.status === "pending"
                      }
                    >
                      {codexAction === "login"
                        ? "Menyiapkan login…"
                        : "Login Codex"}
                    </Button>
                    {selectedCodexModelVerified ? (
                      <Badge variant="success">Codex terverifikasi</Badge>
                    ) : (
                      <Button
                        type="button"
                        onClick={verifyCodexTarget}
                        disabled={
                          codexAction !== null ||
                          campaignAction !== null ||
                          !codexVerificationAvailable ||
                          provider.status === "unavailable"
                        }
                      >
                        {codexAction === "verify"
                          ? "Memverifikasi…"
                          : "Verifikasi Codex"}
                      </Button>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void runCapabilityCampaign("codex_app_server")
                    }
                    disabled={
                      verifying ||
                      codexAction !== null ||
                      campaignAction !== null || !codexCampaignAvailable
                    }
                  >
                    {campaignAction === "codex_app_server"
                      ? "Menjalankan kampanye Codex…"
                      : "Kampanye verifikasi lengkap Codex"}
                  </Button>
                  <p className="helper">
                    3 turn maksimum: dua input terstruktur identik untuk
                    streaming, usage, dan cache; satu turn untuk uji batal dan
                    interrupt. Native tool tetap ditolak kebijakan PromptLab.
                    Budget lengkap diperiksa sebelum turn pertama.
                  </p>
                  <p
                    className="helper"
                    role={
                      codexMessage
                        ? codexMessageFailed
                          ? "alert"
                          : "status"
                        : undefined
                    }
                    aria-live="polite"
                  >
                    {codexMessage ??
                      (selectedCodexModelVerified
                        ? "Model terpilih sudah terverifikasi dan dapat digunakan tanpa verifikasi baru."
                        : "Verifikasi mengirim satu panggilan kecil tanpa retry otomatis dan mencatat pemakaian budget campaign.")}
                  </p>
                </div>
              ) : null}
              {provider.provider === "campus_gateway" ? (
                <div className="stack">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void runCapabilityCampaign("campus_gateway")}
                    disabled={
                      verifying ||
                      codexAction !== null ||
                      campaignAction !== null ||
                      !campusConfigured ||
                      projectPrerequisite !== "satisfied"
                    }
                  >
                    {campaignAction === "campus_gateway"
                      ? "Menjalankan kampanye gateway…"
                      : "Kampanye verifikasi lengkap gateway"}
                  </Button>
                  <p className="helper">
                    4 panggilan maksimum: dua request streaming identik dengan
                    schema, satu forced tool call yang tidak dijalankan, dan
                    satu uji batal lokal. Gateway tidak menyediakan probe
                    kuota atau pembatalan remote pada adapter ini. Budget
                    lengkap diperiksa sebelum request pertama.
                  </p>
                </div>
              ) : null}
              {campaignMessage?.provider === provider.provider ? (
                <p
                  className="helper"
                  role={campaignMessage.failed ? "alert" : "status"}
                  aria-live="polite"
                >
                  {campaignMessage.text}
                </p>
              ) : null}
              <div className="capability-grid">
                {Object.entries(
                  capabilityCampaigns[
                    provider.provider as CampaignProvider
                  ]?.capabilities ?? provider.capabilities,
                ).map(
                  ([name, evidence]) => (
                    <div key={name} className="capability-row">
                      {evidence.status === "policy_restricted" ||
                      evidence.status === "not_exposed" ? (
                        <Shield size={15} aria-hidden="true" />
                      ) : evidence.status === "supported" ? (
                        <CheckCircle2 size={15} aria-hidden="true" />
                      ) : (
                        <CircleHelp size={15} aria-hidden="true" />
                      )}
                      <div className="capability-copy">
                        <span>{labels[name] ?? name}</span>
                        {evidence.reason ? (
                          <span className="capability-reason">
                            {evidence.reason}
                          </span>
                        ) : null}
                      </div>
                      <Badge
                        variant={
                          evidence.status === "supported"
                            ? "success"
                            : evidence.status === "policy_restricted"
                              ? "warning"
                              : evidence.status === "not_exposed"
                                ? "warning"
                                : evidence.status === "unsupported" ||
                                    evidence.status === "failed"
                                ? "danger"
                                : "muted"
                        }
                      >
                        {capabilityLabel(evidence.status)}
                      </Badge>
                    </div>
                  ),
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        {providers.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Status provider belum dimuat</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="helper">
                Periksa konfigurasi backend. Secret tidak ditampilkan pada UI.
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </section>
  );
}

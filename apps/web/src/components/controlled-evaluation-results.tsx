"use client";

import { useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import type {
  ControlledEvaluationCase,
  ControlledEvaluationReport,
  ControlledEvaluationRequest,
  UsageMetric,
  UsageSnapshot,
} from "@promptlab/contracts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ControlledEvaluationRecord,
  ExperimentDecision,
} from "@/lib/experiment-pilot";
import {
  assessControlledPair,
  canAcceptControlledEvaluation,
} from "@/lib/controlled-evaluation-ui";
import type { ControlledArmId } from "./controlled-evaluation-types";
import styles from "./controlled-evaluation-components.module.css";

export function ControlledEvaluationResults({
  experiment,
  report,
  status,
  connection,
  error,
  decisionError,
  decisionBusy,
  onDecision,
}: {
  experiment: ControlledEvaluationRecord;
  report: ControlledEvaluationReport | null;
  status: string;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  error: string | null;
  decisionError: string | null;
  decisionBusy: boolean;
  onDecision: (decision: ExperimentDecision, note: string) => void;
}) {
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionChoice, setDecisionChoice] = useState<ExperimentDecision | "">(
    "",
  );
  const metadata = experiment.metadata;
  const eligibleForAcceptance = canAcceptControlledEvaluation({
    status,
    evidenceEligible: experiment.evidenceEligible,
  });
  const isRunning = ["queued", "running", "cancel_requested"].includes(status);
  const canSaveDecision =
    Boolean(decisionChoice) &&
    !decisionBusy &&
    !isRunning &&
    (decisionChoice !== "accepted" || eligibleForAcceptance);
  const developmentCount = metadata.cases.filter(
    (item) => item.split === "development",
  ).length;
  const holdoutCount = metadata.cases.filter(
    (item) => item.split === "holdout",
  ).length;
  const succeededTargetCalls =
    report?.pairs.reduce(
      (count, pair) =>
        count +
        Number(pair.baseline.status === "succeeded") +
        Number(pair.candidate.status === "succeeded"),
      0,
    ) ?? 0;

  return (
    <div className={styles.results}>
      <div className={styles.resultMeta}>
        <Badge
          variant={
            status === "succeeded" ? "success" : isRunning ? "warning" : "muted"
          }
        >
          {runStatusLabel(status)}
        </Badge>
        <Badge variant={report?.status === "partial" ? "warning" : "muted"}>
          {report
            ? report.status === "complete"
              ? "Laporan lengkap"
              : "Laporan parsial"
            : "Laporan belum tersedia"}
        </Badge>
        <Badge variant={experiment.evidenceEligible ? "success" : "warning"}>
          {experiment.evidenceEligible
            ? "Memenuhi pemeriksaan bukti penerimaan"
            : "Belum memenuhi bukti penerimaan"}
        </Badge>
        <span className="helper">Run {experiment.runId}</span>
      </div>

      {connection === "connecting" || connection === "reconnecting" ? (
        <p className="helper" role="status">
          Mengambil laporan dari riwayat run tersimpan…
        </p>
      ) : null}
      {error ? (
        <p className="error-message" role="status">
          {error}
        </p>
      ) : null}
      {report?.status === "partial" ? (
        <p className="helper" role="status">
          {succeededTargetCalls} dari {report.expectedRequestCount} panggilan
          target berhasil. Status panggilan dan pasangan yang terdampak ditandai
          di bawah.
        </p>
      ) : null}
      {!report && status === "succeeded" ? (
        <p className="helper" role="status">
          Run selesai, tetapi event tidak memuat laporan terkontrol yang valid
          untuk run ini.
        </p>
      ) : null}

      <section
        aria-labelledby="controlled-config-title"
        className={styles.configuration}
      >
        <h3 id="controlled-config-title">Konfigurasi yang dibekukan</h3>
        <dl className={styles.facts}>
          <div>
            <dt>Dataset</dt>
            <dd>
              {metadata.datasetName} · {metadata.datasetVersion}
            </dd>
          </div>
          <div>
            <dt>Kasus</dt>
            <dd>
              {metadata.cases.length} · {developmentCount} development ·{" "}
              {holdoutCount} holdout
            </dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd className={styles.wrap}>{metadata.promptId}</dd>
          </div>
          <div>
            <dt>Baseline tersimpan</dt>
            <dd className={styles.wrap}>{metadata.baselinePromptVersionId}</dd>
          </div>
          <div>
            <dt>Kandidat tersimpan</dt>
            <dd className={styles.wrap}>{metadata.candidatePromptVersionId}</dd>
          </div>
          <div>
            <dt>Optimizer</dt>
            <dd>Tidak digunakan untuk evaluasi ini</dd>
          </div>
        </dl>
        <div className={styles.armCards}>
          {metadata.arms.map((arm) => (
            <article key={arm.arm} className={styles.armCard}>
              <h4>{armLabel(arm.arm)}</h4>
              <dl>
                <div>
                  <dt>Model</dt>
                  <dd>{arm.requestedModel}</dd>
                </div>
                <div>
                  <dt>Kedalaman</dt>
                  <dd>{arm.reasoningEffort ?? "Bawaan model"}</dd>
                </div>
                <div>
                  <dt>Retrieval</dt>
                  <dd>
                    {arm.retrieval.strategy === "graph"
                      ? "GraphRAG"
                      : arm.arm === "rag"
                        ? "RAG leksikal"
                        : "Tanpa sumber"}
                  </dd>
                </div>
                {arm.retrieval.snapshotId ? (
                  <div>
                    <dt>Snapshot</dt>
                    <dd className={styles.wrap}>{arm.retrieval.snapshotId}</dd>
                  </div>
                ) : null}
              </dl>
              {arm.sources.length ? (
                <ul className={styles.frozenSources}>
                  {arm.sources.map((source) => (
                    <li key={source.documentId}>
                      {source.title} · v{source.documentVersion} · checksum{" "}
                      {source.checksum.slice(0, 12)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="helper">Tidak ada sumber yang dibekukan.</p>
              )}
            </article>
          ))}
        </div>
        {report ? (
          <details className={styles.manifestDetails}>
            <summary>Fingerprint laporan dan manifest</summary>
            <dl className={styles.facts}>
              <div>
                <dt>Configuration hash</dt>
                <dd className={styles.wrap}>{report.configurationHash}</dd>
              </div>
              <div>
                <dt>Manifest hash</dt>
                <dd className={styles.wrap}>{report.manifest.manifestHash}</dd>
              </div>
              <div>
                <dt>Hash prompt baseline</dt>
                <dd className={styles.wrap}>{report.baselinePromptHash}</dd>
              </div>
              <div>
                <dt>Hash prompt kandidat</dt>
                <dd className={styles.wrap}>{report.candidatePromptHash}</dd>
              </div>
              <div>
                <dt>Attempt ID</dt>
                <dd className={styles.wrap}>{report.attemptId}</dd>
              </div>
              <div>
                <dt>Optimizer lineage</dt>
                <dd>{report.optimizerLineage.status}</dd>
              </div>
            </dl>
          </details>
        ) : null}
      </section>

      {report || status === "succeeded" ? (
        <section
          aria-labelledby="controlled-cases-title"
          className={styles.caseSection}
        >
          <h3 id="controlled-cases-title">Bukti per kasus</h3>
          <p className="helper">
            Jawaban dipasangkan per metode dan input yang sama. Status validator
            tidak mengukur kualitas umum; kasus tanpa verifier memerlukan
            penilaian manusia.
          </p>
          <div className={styles.caseList}>
            {metadata.cases.map((testCase) => (
              <ControlledCaseDetails
                key={testCase.id}
                testCase={testCase}
                arms={metadata.arms}
                report={report}
              />
            ))}
          </div>
          {report ? (
            <div className={styles.exportRow}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => downloadControlledReport(experiment, report)}
              >
                <Download size={15} aria-hidden="true" /> Ekspor laporan JSON
              </Button>
              <Link className="workspace-result-link" href="/runs">
                Buka riwayat run
              </Link>
            </div>
          ) : null}
        </section>
      ) : (
        <div className="empty-state">
          <div>
            <p>Jawaban belum tersedia.</p>
            <p className="helper">
              Laporan muncul setelah run menyimpan pasangan jawaban baseline dan
              kandidat.
            </p>
          </div>
        </div>
      )}

      <section
        className={styles.decision}
        aria-labelledby="controlled-decision-title"
      >
        <div>
          <h3 id="controlled-decision-title">Keputusan kandidat</h3>
          <p className="helper">
            Keputusan dicatat melalui server. Menerima kandidat memerlukan bukti
            yang memenuhi pemeriksaan; prompt aktif tidak berubah otomatis.
          </p>
        </div>
        {experiment.decision ? (
          <Badge
            variant={
              experiment.decision === "accepted" && !experiment.decisionVerified
                ? "warning"
                : "muted"
            }
          >
            {decisionLabel(experiment.decision, experiment.decisionVerified)}
          </Badge>
        ) : null}
        {!eligibleForAcceptance ? (
          <p className="helper" role="status">
            Penerimaan belum tersedia karena status atau bukti run belum
            memenuhi syarat server.
          </p>
        ) : null}
        {decisionError ? (
          <p className="error-message" role="alert">
            {decisionError}
          </p>
        ) : null}
        <label className="field">
          <span>Keputusan</span>
          <select
            className="select"
            value={decisionChoice}
            onChange={(event) =>
              setDecisionChoice(event.target.value as ExperimentDecision | "")
            }
            disabled={decisionBusy || isRunning}
            required
          >
            <option value="">Pilih keputusan</option>
            <option value="accepted" disabled={!eligibleForAcceptance}>
              Terima kandidat
            </option>
            <option value="rejected">Tolak kandidat</option>
            <option value="inconclusive">Belum meyakinkan</option>
          </select>
        </label>
        <label className="field">
          <span>Catatan keputusan (opsional)</span>
          <input
            className="input"
            maxLength={500}
            value={decisionNote}
            onChange={(event) => setDecisionNote(event.target.value)}
            placeholder="Catat alasan singkat"
          />
        </label>
        <Button
          type="button"
          disabled={!canSaveDecision}
          onClick={() =>
            decisionChoice && onDecision(decisionChoice, decisionNote)
          }
        >
          {decisionBusy ? "Menyimpan keputusan…" : "Simpan keputusan"}
        </Button>
      </section>
    </div>
  );
}

function ControlledCaseDetails({
  testCase,
  arms,
  report,
}: {
  testCase: ControlledEvaluationCase;
  arms: ControlledEvaluationRequest["arms"];
  report: ControlledEvaluationReport | null;
}) {
  const pairs = arms.map((arm) => ({
    arm,
    pair: report?.pairs.find(
      (item) => item.caseId === testCase.id && item.arm === arm.arm,
    ),
  }));
  const assessments = pairs.map((item) => assessControlledPair(item.pair));
  const summary = summarizeAssessments(assessments);
  return (
    <details className={styles.caseRow}>
      <summary>
        <span>
          <strong>{testCase.id}</strong>
          <small>
            {testCase.split === "holdout" ? "Holdout" : "Development"} ·{" "}
            {testCase.input.length.toLocaleString("id-ID")} karakter
          </small>
        </span>
        <Badge
          variant={
            summary.kind === "verified"
              ? "success"
              : summary.kind === "failed"
                ? "danger"
                : "warning"
          }
        >
          {summary.label}
        </Badge>
      </summary>
      <p className={styles.caseInput}>{testCase.input}</p>
      {pairs.map(({ arm, pair }) => (
        <article key={arm.arm} className={styles.pairCard}>
          <div className={styles.pairHeading}>
            <h4>{armLabel(arm.arm)}</h4>
            <Badge variant={badgeVariant(assessControlledPair(pair).kind)}>
              {assessControlledPair(pair).label}
            </Badge>
          </div>
          <p className="helper">{assessControlledPair(pair).detail}</p>
          {pair ? (
            <>
              <div className={styles.answerGrid}>
                <ControlledAnswer title="Baseline" answer={pair.baseline} />
                <ControlledAnswer title="Kandidat" answer={pair.candidate} />
              </div>
              <details className={styles.hashDetails}>
                <summary>Hash pasangan dan jawaban</summary>
                <pre>
                  {JSON.stringify(
                    {
                      inputHash: pair.inputHash,
                      contextHash: pair.contextHash,
                      pairConfigHash: pair.pairConfigHash,
                      baseline: {
                        promptHash: pair.baseline.promptHash,
                        requestHash: pair.baseline.requestHash,
                        contextHash: pair.baseline.contextHash,
                        answerHash: pair.baseline.answerHash,
                      },
                      candidate: {
                        promptHash: pair.candidate.promptHash,
                        requestHash: pair.candidate.requestHash,
                        contextHash: pair.candidate.contextHash,
                        answerHash: pair.candidate.answerHash,
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          ) : (
            <p className="helper">
              Belum ada jawaban pasangan untuk metode ini.
            </p>
          )}
        </article>
      ))}
    </details>
  );
}

function ControlledAnswer({
  title,
  answer,
}: {
  title: string;
  answer: ControlledEvaluationReport["pairs"][number]["baseline"];
}) {
  return (
    <section className={styles.answer} aria-label={title + " " + "per kasus"}>
      <div className={styles.answerHeading}>
        <h5>{title}</h5>
        <Badge variant={answer.status === "succeeded" ? "success" : "danger"}>
          {answer.status === "succeeded"
            ? "Jawaban tersimpan"
            : "Jawaban gagal"}
        </Badge>
      </div>
      <pre className={styles.answerText}>
        {answer.text ?? "Jawaban tidak tersedia."}
      </pre>
      <dl className={styles.answerFacts}>
        <div>
          <dt>Model respons</dt>
          <dd>{answer.responseModel ?? "Tidak tersedia"}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{formatDuration(answer.latencyMs)}</dd>
        </div>
        {answer.usage ? (
          <div className={styles.usageFacts}>
            <dt>Pemakaian</dt>
            <dd>{formatUsage(answer.usage)}</dd>
          </div>
        ) : (
          <div className={styles.usageFacts}>
            <dt>Pemakaian</dt>
            <dd>Tidak tersedia</dd>
          </div>
        )}
      </dl>
      {answer.errorCode ? (
        <p className="helper">Kode error: {answer.errorCode}</p>
      ) : null}
      {answer.verificationEvidence ? (
        <details className={styles.hashDetails}>
          <summary>Bukti validator</summary>
          <pre>{JSON.stringify(answer.verificationEvidence, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}

function formatUsage(usage: UsageSnapshot): string {
  return [
    "Input " + formatMetric(usage.inputTokens),
    "output " + formatMetric(usage.outputTokens),
    "cache read " + formatMetric(usage.cacheReadTokens),
    "cache write " + formatMetric(usage.cacheWriteTokens),
    "kelengkapan " + usage.completeness,
  ].join(" · ");
}

function formatMetric(metric: UsageMetric): string {
  if (metric.value === null) return "Tidak tersedia";
  return (
    metric.value.toLocaleString("id-ID") +
    " token · " +
    (metric.status === "reported" ? "terlapor" : "perkiraan")
  );
}

function formatDuration(value: number | null): string {
  return value === null
    ? "Tidak tersedia"
    : value.toLocaleString("id-ID") + " ms";
}

function summarizeAssessments(
  assessments: ReturnType<typeof assessControlledPair>[],
) {
  if (assessments.some((item) => item.kind === "missing")) {
    return { kind: "missing" as const, label: "Bukti belum lengkap" };
  }
  if (assessments.some((item) => item.kind === "failed")) {
    return { kind: "failed" as const, label: "Validator gagal" };
  }
  if (assessments.some((item) => item.kind === "inconclusive")) {
    return { kind: "inconclusive" as const, label: "Belum konklusif" };
  }
  if (assessments.some((item) => item.kind === "subjective")) {
    return { kind: "subjective" as const, label: "Perlu tinjauan manusia" };
  }
  return {
    kind: "verified" as const,
    label: "Validator lolos pada semua metode",
  };
}

function badgeVariant(
  kind: ReturnType<typeof assessControlledPair>["kind"],
): "success" | "warning" | "danger" | "muted" {
  if (kind === "verified") return "success";
  if (kind === "failed") return "danger";
  if (kind === "subjective") return "muted";
  return "warning";
}

function armLabel(arm: ControlledArmId): string {
  if (arm === "original") return "Original";
  if (arm === "rag") return "RAG";
  return "GraphRAG";
}

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "Disiapkan",
    queued: "Menunggu",
    running: "Berjalan",
    cancel_requested: "Pembatalan diminta",
    paused_quota: "Dijeda karena batas provider",
    paused_auth_required: "Dijeda sampai koneksi siap",
    succeeded: "Selesai",
    failed: "Gagal",
    canceled: "Dibatalkan",
    interrupted_unknown: "Terhenti; hasil tidak diketahui",
  };
  return labels[status] ?? status;
}

function decisionLabel(
  decision: ExperimentDecision,
  verified: boolean,
): string {
  if (decision === "accepted")
    return verified
      ? "Diterima · bukti terverifikasi"
      : "Diterima · bukti belum terverifikasi";
  if (decision === "rejected") return "Ditolak";
  return "Belum meyakinkan";
}

function downloadControlledReport(
  experiment: ControlledEvaluationRecord,
  report: ControlledEvaluationReport,
) {
  const payload = {
    reportVersion: 1,
    experiment: {
      id: experiment.experimentId,
      runId: experiment.runId,
      status: experiment.status,
      createdAt: experiment.createdAt,
      evidenceEligible: experiment.evidenceEligible,
      decisionVerified: experiment.decisionVerified,
      decision: experiment.decision,
      decisionNote: experiment.decisionNote,
      decidedAt: experiment.decidedAt,
      frozen: experiment.metadata,
    },
    report,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = experiment.metadata.datasetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  link.href = url;
  link.download =
    "controlled-evaluation-" +
    (safeName || "promptlab") +
    "-" +
    experiment.metadata.datasetVersion +
    ".json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

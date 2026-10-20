"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  ControlledArm,
  ControlledArmId,
  ControlledEvaluationDraft,
  ControlledModelOption,
  ControlledPromptOption,
  ControlledPromptVersionOption,
  ControlledSourceOption,
} from "./controlled-evaluation-types";
import { Button } from "@/components/ui/button";
import { parseControlledCaseDraft } from "@/lib/controlled-evaluation-ui";
import styles from "./controlled-evaluation-components.module.css";

const requiredArms: readonly {
  id: ControlledArmId;
  label: string;
  description: string;
}[] = [
  {
    id: "original",
    label: "Original",
    description: "Prompt tanpa sumber knowledge",
  },
  { id: "rag", label: "RAG", description: "Retrieval leksikal" },
  {
    id: "graphrag",
    label: "GraphRAG",
    description: "Retrieval graph pada snapshot aktif",
  },
];

export function ControlledEvaluationSetup({
  projectId,
  prompts,
  models,
  selectedModelId,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  modelVerified,
  sources,
  graphSources,
  graphSnapshotId,
  sourceLoadError,
  starting,
  error,
  message,
  onStart,
}: {
  projectId: string | null;
  prompts: ControlledPromptOption[];
  models: ControlledModelOption[];
  selectedModelId: string;
  onModelChange: (value: string) => void;
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  modelVerified: boolean;
  sources: ControlledSourceOption[];
  graphSources: ControlledSourceOption[];
  graphSnapshotId: string | null;
  sourceLoadError: string | null;
  starting: boolean;
  error: string | null;
  message: string | null;
  onStart: (draft: ControlledEvaluationDraft) => void;
}) {
  const [promptId, setPromptId] = useState("");
  const [versions, setVersions] = useState<ControlledPromptVersionOption[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [baselineVersionId, setBaselineVersionId] = useState("");
  const [candidateVersionId, setCandidateVersionId] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [datasetVersion, setDatasetVersion] = useState("v1");
  const [casesText, setCasesText] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);

  useEffect(() => {
    if (!projectId || !promptId) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => setVersionsLoading(true), 0);
    void fetch(
      "/api/projects/" + projectId + "/prompts/" + promptId + "/versions",
      {
        cache: "no-store",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const payload = (await response.json()) as {
          versions?: ControlledPromptVersionOption[];
          error?: string;
          message?: string;
        };
        if (!response.ok) {
          throw new Error(
            payload.message ??
              payload.error ??
              "Riwayat prompt tidak dapat dimuat.",
          );
        }
        setVersions(payload.versions ?? []);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setVersionsError(
            cause instanceof Error
              ? cause.message
              : "Riwayat prompt tidak dapat dimuat.",
          );
        }
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!controller.signal.aborted) setVersionsLoading(false);
      });

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, promptId]);

  const cases = useMemo(() => parseControlledCaseDraft(casesText), [casesText]);
  const baselinePrompt = versions.find(
    (version) => version.id === baselineVersionId,
  );
  const candidatePrompt = versions.find(
    (version) => version.id === candidateVersionId,
  );
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const commonSources = useMemo(() => {
    const graphSourcesById = new Map(
      graphSources.map((source) => [source.id, source]),
    );
    return sources.filter((source) => {
      const graphSource = graphSourcesById.get(source.id);
      return (
        graphSource !== undefined &&
        source.version !== null &&
        source.versionId !== null &&
        source.checksum !== null &&
        source.version === graphSource.version &&
        source.versionId === graphSource.versionId &&
        source.checksum === graphSource.checksum
      );
    });
  }, [graphSources, sources]);
  const newestVersion = Math.max(
    0,
    ...versions.map((version) => version.version),
  );
  const validEffort =
    !reasoningEffort ||
    (selectedModel?.supportedReasoningEfforts ?? []).includes(reasoningEffort);

  let formBlocker: string | null = null;
  if (!projectId) formBlocker = "Pilih proyek sebelum memulai evaluasi.";
  else if (!datasetName.trim() || !datasetVersion.trim()) {
    formBlocker = "Isi nama dan versi dataset.";
  } else if (!promptId) formBlocker = "Pilih prompt tersimpan.";
  else if (versionsLoading) formBlocker = "Menunggu riwayat versi prompt.";
  else if (!baselinePrompt || !candidatePrompt) {
    formBlocker = "Pilih versi baseline dan kandidat yang tersimpan.";
  } else if (baselinePrompt.id === candidatePrompt.id) {
    formBlocker =
      "Baseline dan kandidat harus memakai versi tersimpan yang berbeda.";
  } else if (baselinePrompt.text === candidatePrompt.text) {
    formBlocker =
      "Teks baseline dan kandidat identik; pilih versi dengan teks berbeda.";
  } else if (!selectedModel) formBlocker = "Pilih model Codex.";
  else if (!modelVerified) {
    formBlocker = "Verifikasi model Codex yang dipilih di Pengaturan.";
  } else if (!validEffort) {
    formBlocker = "Kedalaman berpikir tidak didukung model yang dipilih.";
  } else if (sourceLoadError) {
    formBlocker = sourceLoadError;
  } else if (!graphSnapshotId) {
    formBlocker = "Aktifkan snapshot graph yang sesuai sebelum memulai A/R/G.";
  } else if (commonSources.length === 0) {
    formBlocker =
      "Tidak ada sumber aktif yang versinya tercakup pada snapshot GraphRAG.";
  } else if (sourceIds.length === 0) {
    formBlocker =
      "Pilih sedikitnya satu sumber bersama untuk RAG dan GraphRAG.";
  } else if (
    commonSources.filter((source) => sourceIds.includes(source.id)).length !==
    sourceIds.length
  ) {
    formBlocker =
      "Pilihan sumber tidak lagi sama dengan sumber pada snapshot aktif. Muat ulang halaman lalu pilih kembali.";
  } else if (!cases.cases) formBlocker = cases.error;

  function toggleSource(sourceId: string, checked: boolean) {
    setSourceIds((current) =>
      checked
        ? [...new Set([...current, sourceId])]
        : current.filter((id) => id !== sourceId),
    );
  }

  function buildArm(arm: ControlledArmId): ControlledArm {
    const selectedSources =
      arm === "rag" || arm === "graphrag"
        ? commonSources.filter((source) => sourceIds.includes(source.id))
        : [];
    return {
      arm,
      provider: "codex_app_server",
      requestedModel: selectedModelId,
      reasoningEffort: reasoningEffort || null,
      retrieval: {
        strategy: arm === "graphrag" ? "graph" : "lexical",
        sourceIds: selectedSources.map((source) => source.id).sort(),
        snapshotId: arm === "graphrag" ? graphSnapshotId : null,
      },
      sources: selectedSources.map((source) => ({
        documentId: source.id,
        title: source.displayName,
        documentVersionId: source.versionId!,
        documentVersion: source.version!,
        checksum: source.checksum!,
      })),
    };
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      formBlocker ||
      !baselinePrompt ||
      !candidatePrompt ||
      !cases.cases ||
      !promptId ||
      !selectedModel
    ) {
      return;
    }
    onStart({
      datasetName: datasetName.trim(),
      datasetVersion: datasetVersion.trim(),
      promptId,
      baselinePrompt,
      candidatePrompt,
      cases: cases.cases,
      arms: requiredArms.map(({ id }) => buildArm(id)),
      requestedModel: selectedModelId,
      reasoningEffort,
    });
  }

  return (
    <form className={styles.setup} onSubmit={submit}>
      <div className={styles.formGrid}>
        <div className="field">
          <label htmlFor="controlled-dataset-name">Nama dataset</label>
          <input
            id="controlled-dataset-name"
            className="input"
            maxLength={120}
            value={datasetName}
            onChange={(event) => setDatasetName(event.target.value)}
            required
            disabled={starting}
          />
        </div>
        <div className="field">
          <label htmlFor="controlled-dataset-version">Versi dataset</label>
          <input
            id="controlled-dataset-version"
            className="input"
            maxLength={80}
            value={datasetVersion}
            onChange={(event) => setDatasetVersion(event.target.value)}
            required
            disabled={starting}
          />
        </div>
        <div className="field">
          <label htmlFor="controlled-prompt">Prompt yang diuji</label>
          <select
            id="controlled-prompt"
            className="select"
            value={promptId}
            onChange={(event) => {
              setPromptId(event.target.value);
              setVersions([]);
              setBaselineVersionId("");
              setCandidateVersionId("");
              setVersionsLoading(false);
              setVersionsError(null);
            }}
            disabled={!prompts.length || starting}
            required
          >
            <option value="">Pilih prompt tersimpan</option>
            {prompts.map((prompt) => (
              <option key={prompt.id} value={prompt.id}>
                {prompt.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="controlled-baseline-version">
            Versi baseline tersimpan
          </label>
          <select
            id="controlled-baseline-version"
            className="select"
            value={baselineVersionId}
            onChange={(event) => setBaselineVersionId(event.target.value)}
            disabled={!versions.length || starting}
            required
          >
            <option value="">Pilih versi baseline</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version} ·{" "}
                {version.version === newestVersion ? "terbaru" : "riwayat"}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="controlled-candidate-version">
            Versi kandidat tersimpan
          </label>
          <select
            id="controlled-candidate-version"
            className="select"
            value={candidateVersionId}
            onChange={(event) => setCandidateVersionId(event.target.value)}
            disabled={!versions.length || starting}
            required
          >
            <option value="">Pilih versi kandidat</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version} ·{" "}
                {version.version === newestVersion ? "terbaru" : "riwayat"}
              </option>
            ))}
          </select>
          <p className="helper">
            Kedua versi harus berasal dari prompt yang sama dan teksnya harus
            berbeda. Pilihan ini dibekukan pada run.
          </p>
        </div>
        <div className="field">
          <label htmlFor="controlled-model">Model Codex</label>
          <select
            id="controlled-model"
            className="select"
            value={selectedModelId}
            onChange={(event) => onModelChange(event.target.value)}
            disabled={!models.length || starting}
            required
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
            {!models.length ? (
              <option value="">Muat model dari Pengaturan</option>
            ) : null}
          </select>
          {!modelVerified ? (
            <p className="helper" role="status">
              Model ini perlu diverifikasi sebelum evaluasi dapat dimulai.{" "}
              <Link className="knowledge-link" href="/settings">
                Buka Pengaturan
              </Link>
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="controlled-reasoning-effort">
            Kedalaman berpikir
          </label>
          <select
            id="controlled-reasoning-effort"
            className="select"
            value={reasoningEffort}
            onChange={(event) => onReasoningEffortChange(event.target.value)}
            disabled={!selectedModel || starting}
          >
            <option value="">Bawaan model</option>
            {(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </div>
      </div>

      {versionsLoading ? (
        <p className="helper" role="status">
          Memuat versi prompt…
        </p>
      ) : null}
      {versionsError ? (
        <p className="error-message" role="alert">
          {versionsError}
        </p>
      ) : null}

      <div className={styles.armSelection}>
        <p className={styles.armLegend}>Metode otomatis</p>
        <ul className={styles.armOptions} aria-label="Metode yang dibandingkan">
          {requiredArms.map((arm) => (
            <li key={arm.id}>
              <span>
                <strong>{arm.label}</strong>
                <small>
                  {arm.id === "graphrag" && !graphSnapshotId
                    ? "Wajib, menunggu snapshot graph aktif"
                    : arm.description}
                </small>
              </span>
            </li>
          ))}
        </ul>
        <p className="helper">
          Batch selalu mencakup Original, RAG, dan GraphRAG. Pilihan metode
          tidak diperlukan; model dan sumber dibuat sama agar hasilnya setara.
        </p>
      </div>

      <SourceSelection
        sources={commonSources}
        selectedIds={sourceIds}
        disabled={starting}
        sourceLoadError={sourceLoadError}
        graphSnapshotId={graphSnapshotId}
        onToggle={toggleSource}
      />

      <div className="field">
        <label htmlFor="controlled-cases">
          Kasus development dan holdout (JSON)
        </label>
        <textarea
          id="controlled-cases"
          className="input experiment-input"
          value={casesText}
          onChange={(event) => setCasesText(event.target.value)}
          placeholder="Tempel array JSON berisi 2–20 kasus dengan id, split, dan input."
          aria-describedby="controlled-case-help"
          required
          disabled={starting}
        />
        <p id="controlled-case-help" className="helper">
          Kasus harus memiliki ID unik dan sedikitnya satu split development
          serta satu holdout. Label dan verifikasi tetap menjadi bukti
          evaluator; worker tidak mengirimkannya ke model target.
        </p>
        {cases.cases ? (
          <p className="helper" role="status">
            {cases.cases.length} kasus ·{" "}
            {cases.cases.filter((item) => item.split === "development").length}{" "}
            development ·{" "}
            {cases.cases.filter((item) => item.split === "holdout").length}{" "}
            holdout
          </p>
        ) : casesText.trim() ? (
          <p className="error-message" role="status">
            {cases.error}
          </p>
        ) : null}
        <p className="helper" role="status">
          {cases.cases
            ? `${cases.cases.length} kasus × 3 arm × baseline/kandidat = ${cases.cases.length * 6} panggilan target.`
            : "3 arm × baseline/kandidat = 6 panggilan target per kasus."}
        </p>
        <details className={styles.caseExample}>
          <summary>Contoh format kasus</summary>
          <pre>
            {JSON.stringify(
              [
                {
                  id: "dev-1",
                  split: "development",
                  input: "Pertanyaan contoh untuk development.",
                },
                {
                  id: "holdout-1",
                  split: "holdout",
                  input: "Pertanyaan contoh untuk holdout.",
                },
              ],
              null,
              2,
            )}
          </pre>
        </details>
      </div>

      {formBlocker ? (
        <p className="helper" role="status">
          {formBlocker}
        </p>
      ) : null}
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="success-message" role="status">
          {message}
        </p>
      ) : null}
      <div className={styles.submitRow}>
        <Button type="submit" disabled={starting || Boolean(formBlocker)}>
          {starting ? "Menyiapkan evaluasi…" : "Mulai evaluasi terkontrol"}
        </Button>
        <span className="helper">
          Setiap pasangan baseline dan kandidat memakai kasus serta konteks yang
          sama.
        </span>
      </div>
    </form>
  );
}

function SourceSelection({
  sources,
  selectedIds,
  disabled,
  sourceLoadError,
  graphSnapshotId,
  onToggle,
}: {
  sources: ControlledSourceOption[];
  selectedIds: string[];
  disabled: boolean;
  sourceLoadError: string | null;
  graphSnapshotId?: string | null;
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <fieldset className={styles.sourceSelection}>
      <legend>Sumber bersama untuk RAG dan GraphRAG</legend>
      {sourceLoadError ? (
        <p className="error-message" role="alert">
          {sourceLoadError}
        </p>
      ) : null}
      {sources.length ? (
        <div className={styles.sourceList}>
          {sources.map((source) => (
            <label key={source.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(source.id)}
                disabled={disabled}
                onChange={(event) => onToggle(source.id, event.target.checked)}
              />
              <span>
                <strong>{source.displayName}</strong>
                <small>
                  v{source.version} · checksum {source.checksum?.slice(0, 12)}
                  {" · versi ini dipakai oleh kedua metode"}
                </small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="helper">
          {!graphSnapshotId
            ? "Belum ada snapshot graph aktif yang sesuai."
            : "Belum ada sumber yang sama pada RAG dan snapshot GraphRAG."}
        </p>
      )}
      <p className="helper">
        Pilihan versi dan checksum yang sama dibekukan untuk retrieval leksikal
        RAG dan retrieval graph pada snapshot aktif.
      </p>
    </fieldset>
  );
}

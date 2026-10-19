"use client";

import {
  ArrowRight,
  Database,
  GitBranch,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useProjectScope } from "@/components/project-scope";
import type { ProviderConnectionState } from "@promptlab/contracts";

interface Item {
  label: string;
  state: string;
  href: string;
  icon: typeof ShieldCheck;
  variant: "success" | "warning" | "muted";
}

export function OverviewReadiness() {
  const {
    activeProjectId,
    loading: projectsLoading,
    createProject,
  } = useProjectScope();
  const [campus, setCampus] = useState<ProviderConnectionState | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectObjective, setProjectObjective] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [knowledge, setKnowledge] = useState<{
    projectId: string;
    readiness: {
      documents: { eligible: number };
      snapshot: { status: string; id: string | null };
      build: { state: string; id: string | null };
      retrieval: { status: string; graphAvailable: boolean };
    };
  } | null>(null);

  useEffect(() => {
    let active = true;
    const requests: Promise<void>[] = [];
    if (activeProjectId) {
      const projectId = activeProjectId;
      requests.push(
        fetch(`/api/projects/${projectId}/readiness`, { cache: "no-store" })
          .then(async (response) => {
            const result = (await response.json()) as {
              readiness?: {
                documents: { eligible: number };
                snapshot: { status: string; id: string | null };
                build: { state: string; id: string | null };
                retrieval: { status: string; graphAvailable: boolean };
              };
            };
            return response.ok && result.readiness ? result.readiness : null;
          })
          .then((readiness) => {
            if (active)
              setKnowledge(readiness ? { projectId, readiness } : null);
          })
          .catch(() => {
            if (active) setKnowledge(null);
          }),
      );
    }
    requests.push(
      fetch(
        activeProjectId
          ? `/api/providers?projectId=${encodeURIComponent(activeProjectId)}`
          : "/api/providers",
        { cache: "no-store" },
      )
        .then(async (response) =>
          response.ok
            ? (response.json() as Promise<{
                providers?: ProviderConnectionState[];
              }>)
            : null,
        )
        .then((result) => {
          if (active)
            setCampus(
              result?.providers?.find(
                (provider) => provider.provider === "campus_gateway",
              ) ?? null,
            );
        })
        .catch(() => {
          if (active) setCampus(null);
        }),
    );
    void Promise.all(requests).finally(() => {
      if (active) setRefreshing(false);
    });
    return () => {
      active = false;
    };
  }, [activeProjectId, refreshKey]);

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await createProject(projectName, projectObjective);
      setProjectName("");
      setProjectObjective("");
      setCreatingProject(false);
    } catch (cause) {
      setCreateError(
        cause instanceof Error
          ? cause.message
          : "Basis pengetahuan tidak dapat dibuat.",
      );
    } finally {
      setCreateBusy(false);
    }
  }

  const providerReady = campus?.status === "verified";
  const currentKnowledge =
    knowledge?.projectId === activeProjectId ? knowledge.readiness : null;
  const building = Boolean(
    currentKnowledge &&
    ["queued", "extracting", "validating", "ready_to_activate"].includes(
      currentKnowledge.build.state,
    ),
  );
  const snapshotState = !currentKnowledge
    ? "Status belum tersedia"
    : building
      ? "Build sedang berjalan"
      : currentKnowledge.snapshot.status === "active"
        ? "Snapshot aktif"
        : currentKnowledge.snapshot.status === "stale"
          ? "Perlu build ulang"
          : currentKnowledge.build.state === "partial"
            ? "Build parsial"
            : currentKnowledge.build.state === "failed"
              ? "Build gagal"
              : currentKnowledge.documents.eligible
                ? "Sumber siap dibangun"
                : "Tambahkan sumber";
  const graphRetrievalState = !currentKnowledge
    ? "Status belum tersedia"
    : currentKnowledge.retrieval.status !== "ready"
      ? "Backend tidak tersedia"
      : currentKnowledge.retrieval.graphAvailable
        ? "Graph retrieval aktif"
        : "Lexical fallback siap";
  const items: Item[] = [
    {
      label: "Provider kampus",
      state: providerReady
        ? "Terverifikasi"
        : campus?.status === "configured_unverified"
          ? "Belum terverifikasi"
          : "Belum tersedia",
      href: "/settings",
      icon: ShieldCheck,
      variant: providerReady ? "success" : "warning",
    },
    {
      label: "Knowledge snapshot",
      state: snapshotState,
      href: "/knowledge",
      icon: Database,
      variant:
        currentKnowledge?.snapshot.status === "active" ? "success" : "warning",
    },
    {
      label: "GraphRAG retrieval",
      state: graphRetrievalState,
      href: "/knowledge",
      icon: GitBranch,
      variant: currentKnowledge?.retrieval.graphAvailable ? "success" : "muted",
    },
  ];

  return (
    <>
      <section className="readiness-section" aria-label="Status kesiapan">
        <div className="readiness-toolbar">
          <span className="panel-label">Kesiapan proyek</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              setRefreshKey((current) => current + 1);
            }}
            disabled={refreshing}
          >
            <RefreshCw aria-hidden="true" size={15} />
            {refreshing ? "Memuat…" : "Muat ulang"}
          </Button>
        </div>
        <div className="grid-3">
          {items.map(({ label, state, icon: Icon, href, variant }) => (
            <Card key={label}>
              <CardContent className="readiness-card">
                <div className="readiness-icon">
                  <Icon aria-hidden="true" size={17} />
                </div>
                <div className="readiness-copy">
                  <span className="helper">{label}</span>
                  <Badge variant={variant}>{state}</Badge>
                </div>
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  aria-label={`Buka ${label}`}
                >
                  <Link href={href}>
                    <ArrowRight size={15} />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {!projectsLoading && !activeProjectId ? (
        <Card>
          <CardHeader>
            <CardTitle>Buat basis pengetahuan pertama</CardTitle>
            <CardDescription>
              Buat proyek untuk menambahkan dokumen, memilih sumber, dan
              meninjau retrieval.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!creatingProject ? (
              <Button type="button" onClick={() => setCreatingProject(true)}>
                Buat basis pengetahuan
              </Button>
            ) : (
              <form className="project-create-form" onSubmit={submitProject}>
                <label className="field">
                  <span>Nama basis pengetahuan</span>
                  <input
                    className="input"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    maxLength={120}
                    required
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span>
                    Tujuan <span className="helper">(opsional)</span>
                  </span>
                  <input
                    className="input"
                    value={projectObjective}
                    onChange={(event) =>
                      setProjectObjective(event.target.value)
                    }
                    maxLength={2000}
                  />
                </label>
                {createError ? (
                  <p className="error-message" role="alert">
                    {createError}
                  </p>
                ) : null}
                <div className="form-row">
                  <Button type="submit" disabled={createBusy}>
                    {createBusy ? "Membuat…" : "Simpan basis pengetahuan"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setCreatingProject(false)}
                  >
                    Batal
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}

      {activeProjectId && currentKnowledge?.documents.eligible === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Belum ada sumber dokumen</CardTitle>
            <CardDescription>
              Tambahkan teks atau unggah Markdown untuk menyiapkan knowledge
              snapshot dan retrieval.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/knowledge">Tambah sumber</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

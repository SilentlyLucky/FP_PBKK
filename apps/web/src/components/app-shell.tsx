"use client";

import {
  Activity,
  ArrowUpRight,
  BookOpenText,
  Boxes,
  FlaskConical,
  MessageSquareText,
  Menu,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ProjectScopeProvider,
  useProjectScope,
} from "@/components/project-scope";
import { PROVIDER_STATUS_REFRESH_EVENT } from "@/lib/provider-status-refresh";
import type { ProviderConnectionState } from "@promptlab/contracts";

const navigation = [
  { href: "/workspace", label: "Workspace", icon: MessageSquareText },
  { href: "/sources", label: "Sumber", icon: BookOpenText },
  { href: "/experiments", label: "Pengujian", icon: FlaskConical },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/settings", label: "Pengaturan", icon: Settings2 },
] as const;

function ProjectControls() {
  const {
    projects,
    activeProject,
    activeProjectId,
    selectProject,
    createProject,
    loading,
    error,
  } = useProjectScope();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submitProject(formData: FormData) {
    setBusy(true);
    setMessage(null);
    try {
      await createProject(
        String(formData.get("name") ?? ""),
        String(formData.get("objective") ?? ""),
      );
      setCreating(false);
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Proyek tidak dapat dibuat.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-controls">
      <label className="project-select-label" htmlFor="active-project">
        Proyek
      </label>
      <select
        id="active-project"
        className="project-select"
        value={activeProjectId ?? ""}
        disabled={loading || projects.length === 0}
        onChange={(event) => selectProject(event.target.value)}
      >
        {projects.length === 0 ? (
          <option value="">
            {loading
              ? "Memuat proyek…"
              : error
                ? "Proyek tidak tersedia"
                : "Belum ada proyek"}
          </option>
        ) : null}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label="Buat proyek"
        title="Buat proyek"
        aria-expanded={creating}
        onClick={() => setCreating((value) => !value)}
      >
        <Plus aria-hidden="true" size={16} />
      </Button>
      {creating ? (
        <form
          className="project-create-popover"
          action={(formData) => void submitProject(formData)}
        >
          <label className="field">
            <span>Nama proyek</span>
            <input
              className="input"
              name="name"
              maxLength={120}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>
              Tujuan <span className="helper">(opsional)</span>
            </span>
            <input className="input" name="objective" maxLength={2000} />
          </label>
          {message ? (
            <p className="error-message" role="alert">
              {message}
            </p>
          ) : null}
          <div className="form-row">
            <Button type="submit" disabled={busy}>
              {busy ? "Membuat…" : "Buat proyek"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCreating(false)}
            >
              Batal
            </Button>
          </div>
        </form>
      ) : null}
      {activeProject ? (
        <span className="sr-only" aria-live="polite">
          Proyek aktif: {activeProject.name}
        </span>
      ) : null}
    </div>
  );
}

function ProjectLoadStatus() {
  const { error, loading, refresh } = useProjectScope();
  if (!error) return null;

  return (
    <div className="project-load-error" role="status" aria-live="polite">
      <p>Daftar proyek tidak tersedia. {error}</p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={loading}
        onClick={() => void refresh()}
      >
        {loading ? "Memuat…" : "Coba lagi"}
      </Button>
    </div>
  );
}

function ProviderReadiness() {
  const { activeProjectId } = useProjectScope();
  const [codex, setCodex] = useState<ProviderConnectionState | null>(null);

  useEffect(() => {
    let mounted = true;
    let latestRequest = 0;
    const refresh = async () => {
      const requestId = ++latestRequest;
      try {
        const providerUrl = activeProjectId
          ? `/api/providers?projectId=${encodeURIComponent(activeProjectId)}`
          : "/api/providers";
        const response = await fetch(providerUrl, { cache: "no-store" });
        const result = response.ok
          ? ((await response.json()) as {
              providers?: ProviderConnectionState[];
            })
          : null;
        if (mounted && requestId === latestRequest)
          setCodex(
            result?.providers?.find(
              (provider) => provider.provider === "codex_app_server",
            ) ?? null,
          );
      } catch {
        if (mounted && requestId === latestRequest) setCodex(null);
      }
    };
    const handleRefresh = () => void refresh();

    void refresh();
    window.addEventListener(PROVIDER_STATUS_REFRESH_EVENT, handleRefresh);
    return () => {
      mounted = false;
      window.removeEventListener(PROVIDER_STATUS_REFRESH_EVENT, handleRefresh);
    };
  }, [activeProjectId]);

  const ready = codex?.status === "verified";
  const label = ready
    ? "Codex target siap"
    : codex?.status === "configured_unverified"
      ? "Codex target belum terverifikasi"
      : codex?.status === "blocked"
        ? "Codex target diblokir"
        : "Codex target belum tersedia";
  return (
    <Link
      className="readiness-link"
      href="/settings"
      aria-label="Status target Codex"
    >
      <Badge variant={ready ? "success" : "warning"}>
        <span className="status-dot" aria-hidden="true" />
        {label}
      </Badge>
      <ArrowUpRight aria-hidden="true" size={14} />
    </Link>
  );
}

function ShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const activeNavigation = navigation.find(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
  );
  const pageTitle =
    activeNavigation?.label ??
    (pathname.startsWith("/runs") ? "Monitoring" : "PromptLab");

  useEffect(() => {
    if (!mobileMenuOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMobileMenuOpen(false);
      mobileMenuTriggerRef.current?.focus();
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Lewati ke konten
      </a>
      <div className="shell">
        <aside
          className={`sidebar${mobileMenuOpen ? " mobile-menu-open" : ""}`}
        >
          <div className="sidebar-header">
            <Link
              href="/workspace"
              className="brand"
              aria-label="PromptLab Workspace"
              onClick={() => setMobileMenuOpen(false)}
            >
              <span className="brand-mark">
                <Boxes aria-hidden="true" size={16} />
              </span>
              <span className="brand-name">PromptLab</span>
            </Link>
            <Button
              ref={mobileMenuTriggerRef}
              type="button"
              className="mobile-menu-toggle"
              variant="secondary"
              size="icon"
              aria-label={mobileMenuOpen ? "Tutup navigasi" : "Buka navigasi"}
              aria-controls="primary-navigation"
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? (
                <X aria-hidden="true" size={18} />
              ) : (
                <Menu aria-hidden="true" size={18} />
              )}
            </Button>
          </div>
          <nav
            id="primary-navigation"
            className="nav-list"
            aria-label="Navigasi utama"
          >
            {navigation.map(({ href, label, icon: Icon }) => {
              const active =
                pathname === href ||
                pathname.startsWith(`${href}/`) ||
                (href === "/monitoring" && pathname.startsWith("/runs"));
              return (
                <Link
                  key={href}
                  className="nav-link"
                  href={href}
                  prefetch={href === "/experiments" ? false : null}
                  aria-label={label}
                  title={label}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                  <span className="nav-label">{label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="sidebar-footer">Eksperimen prompt berbasis bukti</div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <div className="project-row">
              <span className="current-section">{pageTitle}</span>
              <span className="topbar-divider" aria-hidden="true" />
              <ProjectControls />
            </div>
            <ProviderReadiness />
          </header>
          <main id="main-content" tabIndex={-1} className="shell-main">
            <ProjectLoadStatus />
            {children}
          </main>
        </div>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ProjectScopeProvider>
      <ShellContent>{children}</ShellContent>
    </ProjectScopeProvider>
  );
}

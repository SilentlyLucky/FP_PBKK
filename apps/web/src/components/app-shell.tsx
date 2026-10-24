"use client";

import {
  Activity,
  ArrowUpRight,
  BookOpenText,
  ChevronsUpDown,
  FlaskConical,
  Menu as MenuIcon,
  MessageSquareText,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  ProjectScopeProvider,
  useProjectScope,
} from "@/components/project-scope";
import { SidebarContext } from "@/components/sidebar-slot";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PROVIDER_STATUS_REFRESH_EVENT } from "@/lib/provider-status-refresh";
import type { ProviderConnectionState } from "@promptlab/contracts";

const navigation = [
  { href: "/workspace", label: "Workspace", icon: MessageSquareText },
  { href: "/sources", label: "Sumber", icon: BookOpenText },
  { href: "/experiments", label: "Pengujian", icon: FlaskConical },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/settings", label: "Pengaturan", icon: Settings2 },
] as const;

const SIDEBAR_STORAGE_KEY = "promptlab.sidebar";

function PromptLabMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M12 5.5 6 17M12 5.5 18 17M7.5 18h9" />
      <circle cx="12" cy="5" r="2.6" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="18" r="2.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="18" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

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

  const projectLabel =
    activeProject?.name ??
    (loading
      ? "Memuat proyek…"
      : error
        ? "Proyek tidak tersedia"
        : "Belum ada proyek");
  const avatar = activeProject?.name.trim().charAt(0).toUpperCase() || "P";

  return (
    <div className="project-controls">
      <Menu>
        <MenuTrigger
          id="active-project"
          data-active-project-id={activeProjectId ?? ""}
          className="project-switcher"
          aria-label={`Proyek: ${projectLabel}`}
          title={`Proyek: ${projectLabel}`}
          disabled={loading || projects.length === 0}
        >
          <span className="project-avatar" aria-hidden="true">
            {avatar}
          </span>
          <span className="project-meta">
            <small>Proyek</small>
            <span>{projectLabel}</span>
          </span>
          <ChevronsUpDown
            className="project-chevron"
            aria-hidden="true"
            size={15}
          />
        </MenuTrigger>
        <MenuContent side="top" align="start" className="project-menu">
          <MenuRadioGroup
            value={activeProjectId ?? ""}
            onValueChange={selectProject}
          >
            {projects.map((project) => (
              <MenuRadioItem
                key={project.id}
                value={project.id}
                data-project-id={project.id}
              >
                {project.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem onSelect={() => setCreating(true)}>
            <Plus aria-hidden="true" size={16} />
            Buat proyek
          </MenuItem>
        </MenuContent>
      </Menu>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="project-create-button"
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
  const { activeProject } = useProjectScope();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const isWorkspace = pathname === "/workspace";
  const activeNavigation = navigation.find(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
  );
  const pageTitle =
    activeNavigation?.label ??
    (pathname.startsWith("/runs") ? "Monitoring" : "PromptLab");

  useEffect(() => {
    try {
      // Status ciut hanya diketahui di browser; dibaca setelah hidrasi.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1");
    } catch {
      // Penyimpanan diblokir: sidebar tetap terbentang.
    }
  }, []);

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

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Penyimpanan diblokir: preferensi hanya berlaku untuk sesi ini.
      }
      return next;
    });
  }, []);

  const sidebarContext = useMemo(
    () => ({
      slot,
      mobileOpen: mobileMenuOpen,
      setMobileOpen: setMobileMenuOpen,
    }),
    [slot, mobileMenuOpen],
  );

  return (
    <SidebarContext.Provider value={sidebarContext}>
      <a className="skip-link" href="#main-content">
        Lewati ke konten
      </a>
      <div
        className={`shell${isWorkspace ? " workspace-shell" : ""}${collapsed ? " sidebar-collapsed" : ""}`}
      >
        <div className="mobile-bar">
          <Link
            href="/workspace"
            className="brand"
            aria-label="PromptLab Workspace"
            onClick={() => setMobileMenuOpen(false)}
          >
            <PromptLabMark />
            <span className="brand-name">PromptLab</span>
          </Link>
          <Button
            ref={mobileMenuTriggerRef}
            type="button"
            className="mobile-menu-toggle"
            variant="ghost"
            size="icon"
            aria-label={mobileMenuOpen ? "Tutup navigasi" : "Buka navigasi"}
            aria-controls="primary-navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {mobileMenuOpen ? (
              <X aria-hidden="true" size={18} />
            ) : (
              <MenuIcon aria-hidden="true" size={18} />
            )}
          </Button>
        </div>
        {mobileMenuOpen ? (
          <div
            className="sidebar-scrim"
            aria-hidden="true"
            onClick={() => setMobileMenuOpen(false)}
          />
        ) : null}
        <div
          className={`sidebar${mobileMenuOpen ? " sidebar-open" : ""}${process.env.NODE_ENV === "development" ? " sidebar-dev" : ""}`}
        >
          <div className="sidebar-header">
            <Link
              href="/workspace"
              className="brand"
              aria-label="PromptLab Workspace"
              title="Eksperimen prompt berbasis bukti"
              onClick={() => setMobileMenuOpen(false)}
            >
              <PromptLabMark />
              <span className="brand-name">PromptLab</span>
            </Link>
            <Button
              type="button"
              className="sidebar-collapse"
              variant="ghost"
              size="icon"
              aria-label={collapsed ? "Bentangkan sidebar" : "Ciutkan sidebar"}
              aria-pressed={collapsed}
              onClick={toggleCollapsed}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" size={17} />
              ) : (
                <PanelLeftClose aria-hidden="true" size={17} />
              )}
            </Button>
          </div>
          {!isWorkspace ? (
            <Link
              className="sidebar-new"
              href="/workspace"
              onClick={() => setMobileMenuOpen(false)}
            >
              <MessageSquarePlus aria-hidden="true" size={17} />
              <span className="nav-label">Percakapan baru</span>
            </Link>
          ) : null}
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
          <div ref={setSlot} className="sidebar-slot" />
          <div className="sidebar-footer">
            <ProjectControls />
            <ProviderReadiness />
            <ThemeToggle />
          </div>
        </div>
        <div className="main-column">
          {!isWorkspace ? (
            <div className="topbar">
              <span className="breadcrumb">
                {activeProject?.name ?? "PromptLab"}
                <span aria-hidden="true"> / </span>
                {pageTitle}
              </span>
            </div>
          ) : null}
          <main
            id="main-content"
            tabIndex={-1}
            className={`shell-main${isWorkspace ? " workspace-main" : ""}`}
          >
            <ProjectLoadStatus />
            {children}
          </main>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ProjectScopeProvider>
      <ShellContent>{children}</ShellContent>
    </ProjectScopeProvider>
  );
}

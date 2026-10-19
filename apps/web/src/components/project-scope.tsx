"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export interface ProjectSummary {
  id: string;
  name: string;
  objective: string | null;
}

interface ProjectScopeValue {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  activeProject: ProjectSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectProject: (projectId: string) => void;
  createProject: (name: string, objective: string) => Promise<void>;
}

const ProjectScopeContext = createContext<ProjectScopeValue | null>(null);
const ACTIVE_PROJECT_KEY = "promptlab.activeProjectId";

export function ProjectScopeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    const result = (await response.json()) as {
      projects?: ProjectSummary[];
      error?: string;
      message?: string;
    };
    if (!response.ok)
      throw new Error(
        result.message ?? result.error ?? "Daftar proyek tidak dapat dimuat.",
      );
    return result.projects ?? [];
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextProjects = await loadProjects();
      setProjects(nextProjects);
      const preferredId = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
      const next = nextProjects.some(
        (project) => project.id === activeProjectId,
      )
        ? activeProjectId
        : nextProjects.some((project) => project.id === preferredId)
          ? preferredId
          : (nextProjects[0]?.id ?? null);
      setActiveProjectId(next);
      if (next) window.localStorage.setItem(ACTIVE_PROJECT_KEY, next);
      else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Daftar proyek tidak dapat dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, loadProjects]);

  useEffect(() => {
    let current = true;
    loadProjects()
      .then((nextProjects) => {
        if (!current) return;
        setProjects(nextProjects);
        const preferredId = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
        const next = nextProjects.some((project) => project.id === preferredId)
          ? preferredId
          : (nextProjects[0]?.id ?? null);
        setActiveProjectId(next);
        if (next) window.localStorage.setItem(ACTIVE_PROJECT_KEY, next);
        else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
        setError(null);
      })
      .catch((cause) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Daftar proyek tidak dapat dimuat.",
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [loadProjects]);

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  }, []);

  const createProject = useCallback(
    async (name: string, objective: string) => {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, objective: objective || null }),
      });
      const result = (await response.json()) as {
        project?: ProjectSummary;
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.project)
        throw new Error(
          result.message ?? result.error ?? "Proyek tidak dapat dibuat.",
        );
      await refresh();
      selectProject(result.project.id);
    },
    [refresh, selectProject],
  );

  const value = useMemo<ProjectScopeValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject:
        projects.find((project) => project.id === activeProjectId) ?? null,
      loading,
      error,
      refresh,
      selectProject,
      createProject,
    }),
    [
      projects,
      activeProjectId,
      loading,
      error,
      refresh,
      selectProject,
      createProject,
    ],
  );

  return (
    <ProjectScopeContext.Provider value={value}>
      {children}
    </ProjectScopeContext.Provider>
  );
}

export function useProjectScope(): ProjectScopeValue {
  const context = useContext(ProjectScopeContext);
  if (!context)
    throw new Error("useProjectScope must be used inside ProjectScopeProvider");
  return context;
}

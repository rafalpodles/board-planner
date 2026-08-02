"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { ApiProject } from "@/types";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";

interface ProjectsState {
  projects: ApiProject[];
  isLoading: boolean;
  reload: () => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
}

const ProjectsContext = createContext<ProjectsState | null>(null);

export { ProjectsContext };

export function useProjectsProvider(): ProjectsState {
  const api = useApi();
  const { user } = useAuth();
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setProjects(await api.get("/api/projects"));
    } catch {
      // The shell must still render if this fails; pages surface their own errors
      setProjects([]);
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!user) {
      setProjects([]);
      setIsLoading(false);
      return;
    }
    reload();
  }, [user, reload]);

  // Applied locally first so the row lands where it was dropped; a failed write
  // snaps back rather than leaving the sidebar disagreeing with the database
  const reorder = useCallback(
    async (orderedIds: string[]) => {
      const previous = projects;
      const byId = new Map(previous.map((p) => [p._id, p]));
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((p): p is ApiProject => !!p);
      if (next.length !== previous.length) return;

      setProjects(next);
      try {
        await api.put("/api/projects/reorder", { order: orderedIds });
      } catch {
        setProjects(previous);
      }
    },
    [api, projects]
  );

  return useMemo(
    () => ({ projects, isLoading, reload, reorder }),
    [projects, isLoading, reload, reorder]
  );
}

export function useProjects(): ProjectsState {
  const ctx = useContext(ProjectsContext);
  if (!ctx) {
    throw new Error("useProjects must be used within ProjectsProvider");
  }
  return ctx;
}

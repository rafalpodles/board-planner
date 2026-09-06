"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
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
  const appliedSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++appliedSeq.current;
    try {
      const list = await api.get("/api/projects");
      if (seq !== appliedSeq.current) return;
      setProjects(list);
    } catch {
      if (seq !== appliedSeq.current) return;
      setProjects([]);
    } finally {
      if (seq === appliedSeq.current) setIsLoading(false);
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

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      const previous = projects;
      const byId = new Map(previous.map((p) => [p._id, p]));
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((p): p is ApiProject => !!p);
      if (previous.length === 0 || next.length !== previous.length) return;

      const seq = ++appliedSeq.current;
      setProjects(next);
      try {
        await api.put("/api/projects/reorder", { order: orderedIds });
      } catch {
        if (seq !== appliedSeq.current) return;
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

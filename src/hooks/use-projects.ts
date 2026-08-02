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

  return useMemo(
    () => ({ projects, isLoading, reload }),
    [projects, isLoading, reload]
  );
}

export function useProjects(): ProjectsState {
  const ctx = useContext(ProjectsContext);
  if (!ctx) {
    throw new Error("useProjects must be used within ProjectsProvider");
  }
  return ctx;
}

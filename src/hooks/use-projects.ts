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

  // A read carries the order of the moment it was answered, so one overtaken by a later read or by
  // a reorder applies nothing — landing late it would undo them, which is how a drag came to revert
  // itself on screen while the server kept it (BP-551)
  const reload = useCallback(async () => {
    const seq = ++appliedSeq.current;
    try {
      const list = await api.get("/api/projects");
      if (seq !== appliedSeq.current) return;
      setProjects(list);
    } catch {
      // The shell must still render if this fails; pages surface their own errors
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

  // Applied locally first so the row lands where it was dropped; a failed write
  // snaps back rather than leaving the sidebar disagreeing with the database
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
        // `previous` is the order this drop replaced, so restoring it over a later drop would put
        // back something older still
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

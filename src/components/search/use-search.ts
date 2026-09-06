"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiProject, ApiProjectColumn, ApiTask, DEFAULT_PROJECT_ICON, TaskStatus } from "@/types";
import { useApi } from "@/hooks/use-api";
import { projectPath, taskPath } from "@/lib/urls";
import { useOpenTask } from "@/hooks/use-open-task";

// Matches the API, which refuses anything shorter
export const MIN_QUERY = 2;

export type HitGroup = "current" | "other";

export interface SearchHit {
  id: string;
  kind: "project" | "task";
  href: string;
  label: string;
  meta: string;
  icon?: string;
  status?: TaskStatus;
  priority?: ApiTask["priority"];
  projectName?: string;
  projectKey?: string;
  projectId?: string;
}

function projectOf(task: ApiTask): { _id?: string; key?: string; name?: string } | null {
  const project = task.project as unknown as { _id?: string; key?: string; name?: string } | string;
  return typeof project === "object" && project !== null ? project : null;
}

export function matchProjects(projects: ApiProject[], query: string): ApiProject[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return projects.filter(
    (p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)
  );
}

export function toHits(projects: ApiProject[], tasks: ApiTask[]): SearchHit[] {
  return [
    ...projects.map((p) => ({
      id: `project:${p._id}`,
      kind: "project" as const,
      href: projectPath(p.key),
      label: p.name,
      meta: p.key,
      icon: p.icon || DEFAULT_PROJECT_ICON,
      projectKey: p.key,
      projectId: p._id,
    })),
    ...tasks.map((t) => {
      const project = projectOf(t);
      const ref = project ? (project.key ?? project._id) : (t.project as unknown as string);
      return {
        id: `task:${t._id}`,
        kind: "task" as const,
        href: taskPath(ref as string, t.taskNumber),
        label: t.title,
        meta: project?.key ? `${project.key}-${t.taskNumber}` : `#${t.taskNumber}`,
        status: t.status,
        priority: t.priority,
        projectName: project?.name,
        projectKey: project?.key,
        projectId: project?._id,
      };
    }),
  ];
}

/** Columns are project-defined since CP-128, so a hit's status only reads correctly through its own project */
export function columnOf(
  hit: SearchHit,
  projects: ApiProject[]
): ApiProjectColumn | undefined {
  if (!hit.status) return undefined;
  const project = projects.find(
    (p) => p._id === hit.projectId || (!!hit.projectKey && p.key === hit.projectKey)
  );
  return project?.columns?.find((c) => c.id === hit.status);
}

export function groupOf(hit: SearchHit, currentProjectRef?: string): HitGroup {
  if (!currentProjectRef) return "other";
  const ref = currentProjectRef.toLowerCase();
  return hit.projectKey?.toLowerCase() === ref || hit.projectId === currentProjectRef
    ? "current"
    : "other";
}

/** Current project's hits first, so the two groups render as two contiguous runs */
export function sortByGroup(hits: SearchHit[], currentProjectRef?: string): SearchHit[] {
  if (!currentProjectRef) return hits;
  return [
    ...hits.filter((h) => groupOf(h, currentProjectRef) === "current"),
    ...hits.filter((h) => groupOf(h, currentProjectRef) === "other"),
  ];
}

export function useSearch(
  projects: ApiProject[],
  currentProjectRef?: string,
  initialQuery = ""
) {
  const api = useApi();
  const openTask = useOpenTask();
  const [query, setQuery] = useState(initialQuery);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const trimmed = query.trim();
  const active = trimmed.length >= MIN_QUERY;

  useEffect(() => {
    if (!active) {
      setTasks([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api.get(`/api/search?q=${encodeURIComponent(trimmed)}`);
        if (!cancelled) setTasks(data);
      } catch {
        if (!cancelled) setTasks([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, active, api]);

  const hits = useMemo(
    () =>
      active
        ? sortByGroup(toHits(matchProjects(projects, trimmed), tasks), currentProjectRef)
        : [],
    [active, projects, trimmed, tasks, currentProjectRef]
  );

  // A shrinking result set would otherwise leave the cursor past the end
  useEffect(() => setSelectedIndex(0), [trimmed]);

  const reset = useCallback(() => {
    setQuery("");
    setTasks([]);
    setSelectedIndex(0);
  }, []);

  const open = useCallback(
    (hit: SearchHit) => {
      openTask(hit.href);
      reset();
    },
    [openTask, reset]
  );

  return {
    query,
    setQuery,
    trimmed,
    active,
    loading,
    hits,
    selectedIndex,
    setSelectedIndex,
    reset,
    open,
  };
}

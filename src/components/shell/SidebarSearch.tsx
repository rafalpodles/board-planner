"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiProject, ApiTask, DEFAULT_PROJECT_ICON } from "@/types";
import { useApi } from "@/hooks/use-api";
import { projectPath, taskPath } from "@/lib/urls";

// Matches the API, which refuses anything shorter
export const MIN_QUERY = 2;

export interface SearchHit {
  id: string;
  kind: "project" | "task";
  href: string;
  label: string;
  meta: string;
  icon?: string;
}

function projectRefOf(task: ApiTask): string {
  const project = task.project as unknown as { _id: string; key?: string } | string;
  return typeof project === "object" && project !== null
    ? (project.key ?? project._id)
    : (project as string);
}

function projectKeyOf(task: ApiTask): string | null {
  const project = task.project as unknown as { key?: string } | string;
  return typeof project === "object" && project !== null ? (project.key ?? null) : null;
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
    })),
    ...tasks.map((t) => {
      const key = projectKeyOf(t);
      return {
        id: `task:${t._id}`,
        kind: "task" as const,
        href: taskPath(projectRefOf(t), t.taskNumber),
        label: t.title,
        meta: key ? `${key}-${t.taskNumber}` : `#${t.taskNumber}`,
      };
    }),
  ];
}

export function useSidebarSearch(projects: ApiProject[]) {
  const api = useApi();
  const router = useRouter();
  const [query, setQuery] = useState("");
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
    () => (active ? toHits(matchProjects(projects, trimmed), tasks) : []),
    [active, projects, trimmed, tasks]
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
      router.push(hit.href);
      reset();
    },
    [router, reset]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        reset();
        return;
      }
      if (!hits.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % hits.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + hits.length) % hits.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        open(hits[selectedIndex]);
      }
    },
    [hits, selectedIndex, open, reset]
  );

  return {
    query,
    setQuery,
    active,
    loading,
    hits,
    selectedIndex,
    setSelectedIndex,
    handleKeyDown,
    reset,
    open,
  };
}

interface FieldProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onClear: () => void;
}

export function SidebarSearchField({ value, onChange, onKeyDown, onClear }: FieldProps) {
  return (
    <div className="relative px-2.5 pb-2.5">
      <input
        // type=text, not search: the native clear affordance would sit on top of ours
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search tasks and projects"
        aria-label="Search tasks and projects"
        className="focus-ring h-[44px] w-full rounded-lg border border-border bg-bg-input py-2 pl-3 pr-[34px] text-[13px] text-text placeholder:text-text-muted md:h-auto"
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="focus-ring absolute right-4 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-muted hover:text-text"
        >
          ✕
        </button>
      ) : (
        <kbd className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 rounded border border-border bg-bg-card px-1 py-0.5 font-mono text-[10px] text-text-muted">
          ⌘K
        </kbd>
      )}
    </div>
  );
}

interface ResultsProps {
  hits: SearchHit[];
  loading: boolean;
  selectedIndex: number;
  onHover: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
}

export function SidebarSearchResults({
  hits,
  loading,
  selectedIndex,
  onHover,
  onOpen,
}: ResultsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!hits.length) {
    return (
      <p className="px-2.5 py-3 text-[13px] text-text-muted">
        {loading ? "Searching…" : "No matches"}
      </p>
    );
  }

  return (
    <div ref={listRef} role="listbox" aria-label="Search results" className="flex flex-col gap-px">
      {hits.map((hit, index) => (
        <button
          key={hit.id}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          data-selected={index === selectedIndex}
          onMouseEnter={() => onHover(index)}
          onClick={() => onOpen(hit)}
          className={`focus-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors ${
            index === selectedIndex ? "bg-bg-hover text-text" : "text-text-muted hover:bg-bg-hover"
          }`}
        >
          {hit.icon && (
            <span aria-hidden className="text-[15px] leading-none">
              {hit.icon}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{hit.label}</span>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">{hit.meta}</span>
        </button>
      ))}
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ApiTask,
  ApiLabel,
  DIFFICULTIES,
  CATEGORIES,
  SORT_OPTIONS,
  SortField,
  SortDir,
  Difficulty,
  Category,
} from "@/types";

interface Filters {
  search: string;
  assignee: string;
  component: string;
  category: string;
  difficulty: string;
  label: string;
  dateRange: string;
}

const DATE_PRESETS = [
  { value: "", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "last_7", label: "Last 7 days" },
  { value: "last_30", label: "Last 30 days" },
  { value: "stale_14", label: "Stale (>14d)" },
] as const;

interface PersistedState {
  filters: Omit<Filters, "search">;
  myTasks: boolean;
  sortField: SortField;
  sortDir: SortDir;
  showFilters: boolean;
}

function loadPersistedState(projectId: string): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(`board-filters:${projectId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePersistedState(projectId: string, state: PersistedState) {
  try {
    localStorage.setItem(`board-filters:${projectId}`, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable
  }
}

interface BoardFiltersProps {
  tasks: ApiTask[];
  components: string[];
  labels?: ApiLabel[];
  projectId: string;
  currentUsername?: string;
  onFilter: (filtered: ApiTask[]) => void;
}

export function BoardFilters({ tasks, components, labels = [], projectId, currentUsername, onFilter }: BoardFiltersProps) {
  const [initialized, setInitialized] = useState(false);
  const persisted = initialized ? undefined : loadPersistedState(projectId);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    assignee: persisted?.filters?.assignee ?? "",
    component: persisted?.filters?.component ?? "",
    category: persisted?.filters?.category ?? "",
    difficulty: persisted?.filters?.difficulty ?? "",
    label: (persisted?.filters as Record<string, string>)?.label ?? "",
    dateRange: (persisted?.filters as Record<string, string>)?.dateRange ?? "",
  });
  const [myTasks, setMyTasks] = useState(persisted?.myTasks ?? false);
  const [sortField, setSortField] = useState<SortField>(persisted?.sortField ?? "updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>(persisted?.sortDir ?? "desc");
  const [showFilters, setShowFilters] = useState(persisted?.showFilters ?? false);

  // Mark as initialized after first render
  useEffect(() => { setInitialized(true); }, []);

  // Persist filter state on change
  const persistState = useCallback(() => {
    savePersistedState(projectId, {
      filters: {
        assignee: filters.assignee,
        component: filters.component,
        category: filters.category,
        difficulty: filters.difficulty,
        label: filters.label,
        dateRange: filters.dateRange,
      },
      myTasks,
      sortField,
      sortDir,
      showFilters,
    });
  }, [projectId, filters, myTasks, sortField, sortDir, showFilters]);

  useEffect(() => {
    if (initialized) persistState();
  }, [initialized, persistState]);

  const assignees = Array.from(
    new Map(
      tasks
        .filter((t) => t.assignee && typeof t.assignee === "object")
        .map((t) => {
          const a = t.assignee as { _id: string; username: string };
          return [a.username, a];
        })
    ).values()
  );

  const hasActiveFilters = myTasks || filters.assignee || filters.component || filters.category || filters.difficulty || filters.label || filters.dateRange;

  useEffect(() => {
    let result = tasks;

    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter((t) => t.title.toLowerCase().includes(q));
    }
    if (myTasks && currentUsername) {
      result = result.filter(
        (t) =>
          t.assignee &&
          typeof t.assignee === "object" &&
          t.assignee.username === currentUsername
      );
    }
    if (filters.assignee) {
      result = result.filter(
        (t) =>
          t.assignee &&
          typeof t.assignee === "object" &&
          t.assignee.username === filters.assignee
      );
    }
    if (filters.component) {
      result = result.filter((t) => t.component === filters.component);
    }
    if (filters.category) {
      result = result.filter((t) => t.category === filters.category);
    }
    if (filters.difficulty) {
      result = result.filter((t) => t.difficulty === filters.difficulty);
    }
    if (filters.label) {
      result = result.filter((t) => (t.labels || []).includes(filters.label));
    }
    if (filters.dateRange) {
      const now = Date.now();
      const DAY = 86_400_000;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      result = result.filter((t) => {
        const updated = new Date(t.updatedAt).getTime();
        const created = new Date(t.createdAt).getTime();
        switch (filters.dateRange) {
          case "today":
            return created >= startOfToday.getTime() || updated >= startOfToday.getTime();
          case "this_week": {
            const day = startOfToday.getDay();
            const weekStart = startOfToday.getTime() - (day === 0 ? 6 : day - 1) * DAY;
            return created >= weekStart || updated >= weekStart;
          }
          case "last_7":
            return created >= now - 7 * DAY || updated >= now - 7 * DAY;
          case "last_30":
            return created >= now - 30 * DAY || updated >= now - 30 * DAY;
          case "stale_14":
            return updated < now - 14 * DAY && t.status !== "done";
          default:
            return true;
        }
      });
    }

    // Sort
    const difficultyOrder: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };
    const dir = sortDir === "asc" ? 1 : -1;

    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "updatedAt":
        case "createdAt":
          cmp = new Date(a[sortField]).getTime() - new Date(b[sortField]).getTime();
          break;
        case "difficulty":
          cmp = (difficultyOrder[a.difficulty] ?? 0) - (difficultyOrder[b.difficulty] ?? 0);
          break;
        case "category":
          cmp = a.category.localeCompare(b.category);
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
      }
      return cmp * dir;
    });

    onFilter(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, tasks, sortField, sortDir, myTasks, currentUsername, labels]);

  function clearFilters() {
    setMyTasks(false);
    setFilters({ search: "", assignee: "", component: "", category: "", difficulty: "", label: "", dateRange: "" });
    setSortField("updatedAt");
    setSortDir("desc");
  }

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search tasks..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="w-full text-sm bg-bg-input border border-border rounded-lg pl-9 pr-3 py-1.5
              text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {currentUsername && (
          <button
            onClick={() => setMyTasks((v) => !v)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors
              ${myTasks
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-text-muted hover:text-text hover:border-border"
              }`}
          >
            My tasks
          </button>
        )}

        <select
          value={sortField}
          onChange={(e) => {
            const field = e.target.value as SortField;
            setSortField(field);
            setSortDir(SORT_OPTIONS.find((o) => o.value === field)?.defaultDir ?? "desc");
          }}
          className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <button
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          className="text-xs px-2 py-1.5 rounded-lg border border-border text-text-muted hover:text-text hover:border-border transition-colors"
          title={sortDir === "asc" ? "Ascending" : "Descending"}
        >
          {sortDir === "asc" ? "\u2191" : "\u2193"}
        </button>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors
            ${hasActiveFilters
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-text-muted hover:text-text hover:border-border"
            }`}
        >
          Filters{hasActiveFilters ? " *" : ""}
        </button>

        {(hasActiveFilters || filters.search) && (
          <button
            onClick={clearFilters}
            className="text-xs text-text-muted hover:text-text"
          >
            Clear
          </button>
        )}
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-2">
          <select
            value={filters.assignee}
            onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
            className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All assignees</option>
            {assignees.map((a) => (
              <option key={a.username} value={a.username}>{a.username}</option>
            ))}
          </select>

          {components.length > 0 && (
            <select
              value={filters.component}
              onChange={(e) => setFilters((f) => ({ ...f, component: e.target.value }))}
              className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">All components</option>
              {components.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}

          <select
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
            className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c: Category) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            value={filters.difficulty}
            onChange={(e) => setFilters((f) => ({ ...f, difficulty: e.target.value }))}
            className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All sizes</option>
            {DIFFICULTIES.map((d: Difficulty) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          {labels.length > 0 && (
            <select
              value={filters.label}
              onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}
              className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">All labels</option>
              {labels.map((l) => (
                <option key={l._id} value={l._id}>{l.name}</option>
              ))}
            </select>
          )}

          <select
            value={filters.dateRange}
            onChange={(e) => setFilters((f) => ({ ...f, dateRange: e.target.value }))}
            className="text-xs bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

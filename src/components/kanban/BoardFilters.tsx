"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ApiTask,
  ApiLabel,
  ApiProjectCategory,
  DIFFICULTIES,
  CATEGORIES,
  PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  SORT_OPTIONS,
  SortField,
  SortDir,
  Difficulty,
  Category,
  Priority,
} from "@/types";
import { categoryColor } from "@/lib/category-colors";
import {
  BoardFilterValues,
  EMPTY_FILTERS,
  countActiveFilters,
  migratePersistedFilters,
} from "@/lib/board-filters-state";

interface Filters extends BoardFilterValues {
  search: string;
}

const DATE_PRESETS = [
  { value: "", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "last_7", label: "Last 7 days" },
  { value: "last_30", label: "Last 30 days" },
  { value: "stale_14", label: "Stale (>14d)" },
] as const;

function savePersistedState(
  projectId: string,
  state: { filters: BoardFilterValues; sortField: SortField; sortDir: SortDir; showFilters: boolean }
) {
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
  categories?: string[];
  projectKey?: string;
  projectId: string;
  currentUsername?: string;
  projectCategories?: ApiProjectCategory[];
  extraControls?: React.ReactNode;
  onFilter: (filtered: ApiTask[]) => void;
}

export function BoardFilters({
  tasks,
  components,
  labels = [],
  categories = [],
  projectKey,
  projectId,
  currentUsername,
  projectCategories,
  extraControls,
  onFilter,
}: BoardFiltersProps) {
  const [initialized, setInitialized] = useState(false);
  const [filters, setFilters] = useState<Filters>({ search: "", ...EMPTY_FILTERS });
  const [sortField, setSortField] = useState<SortField>("manual");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showFilters, setShowFilters] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Reading localStorage during render produces an SSR/client hydration mismatch
  useEffect(() => {
    let raw: unknown = null;
    try {
      const stored = localStorage.getItem(`board-filters:${projectId}`);
      raw = stored ? JSON.parse(stored) : null;
    } catch {
      raw = null;
    }
    const state = migratePersistedFilters(raw, currentUsername);
    setFilters((f) => ({ ...f, ...state.filters }));
    setSortField(state.sortField);
    setSortDir(state.sortDir);
    setShowFilters(state.showFilters);
    setInitialized(true);
  }, [projectId, currentUsername]);

  const persistState = useCallback(() => {
    const { search: _search, ...rest } = filters;
    void _search;
    savePersistedState(projectId, { filters: rest, sortField, sortDir, showFilters });
  }, [projectId, filters, sortField, sortDir, showFilters]);

  useEffect(() => {
    if (initialized) persistState();
  }, [initialized, persistState]);

  useEffect(() => {
    if (!showFilters) return;
    function onClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [showFilters]);

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

  const activeCount = countActiveFilters(filters);
  const hasActiveFilters = activeCount > 0;

  useEffect(() => {
    let result = tasks;

    if (filters.search) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter((t) => {
        if (t.title.toLowerCase().includes(q)) return true;
        // Task-key search: "cp-128", "CP-128" and bare "128" all match CP-128
        const key = `${projectKey ?? ""}-${t.taskNumber}`.toLowerCase();
        return key.includes(q) || String(t.taskNumber).startsWith(q);
      });
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
    if (filters.priority) {
      result = result.filter((t) => t.priority === filters.priority);
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

    const difficultyOrder: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };
    const dir = sortDir === "asc" ? 1 : -1;

    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        // Mirrors the API's own ordering, so drag-and-drop reordering survives
        case "manual":
          cmp =
            (a.order ?? 0) - (b.order ?? 0) ||
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          break;
        case "updatedAt":
        case "createdAt":
          cmp = new Date(a[sortField]).getTime() - new Date(b[sortField]).getTime();
          break;
        case "priority":
          cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
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
  }, [filters, tasks, sortField, sortDir, currentUsername, labels, projectKey]);

  function clearFilters() {
    setFilters((f) => ({ ...EMPTY_FILTERS, search: f.search }));
  }

  function unset(key: keyof BoardFilterValues) {
    setFilters((f) => ({ ...f, [key]: "" }));
  }

  const chips: { key: keyof BoardFilterValues; label: string; colour?: string; initial?: string }[] =
    [];
  if (filters.assignee) {
    chips.push({
      key: "assignee",
      label: filters.assignee,
      initial: filters.assignee.charAt(0).toUpperCase(),
    });
  }
  if (filters.category) {
    chips.push({
      key: "category",
      label: filters.category,
      colour: categoryColor(projectCategories, filters.category) || undefined,
    });
  }
  if (filters.component) chips.push({ key: "component", label: filters.component });
  if (filters.difficulty) chips.push({ key: "difficulty", label: filters.difficulty });
  if (filters.priority) {
    chips.push({ key: "priority", label: PRIORITY_LABELS[filters.priority as Priority] });
  }
  if (filters.label) {
    chips.push({
      key: "label",
      label: labels.find((l) => l._id === filters.label)?.name ?? filters.label,
    });
  }
  if (filters.dateRange) {
    chips.push({
      key: "dateRange",
      label: DATE_PRESETS.find((p) => p.value === filters.dateRange)?.label ?? filters.dateRange,
    });
  }

  const selectClass =
    "h-8 w-full rounded-lg border border-border bg-bg-input px-2 text-[12px] text-text focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-6 py-2.5">
      {/* Basis below the target width so the row fits before anything wraps;
          it grows back up to 200px whenever there is room */}
      <div className="relative min-w-0 max-w-[200px] flex-[1_1_120px]">
        <svg
          className="pointer-events-none absolute left-2.5 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          placeholder={`Search tasks, or ${projectKey ?? "CP"}-128…`}
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          className="h-[34px] w-full rounded-lg border border-border bg-bg-card pl-8 pr-2.5 text-[13px] text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="h-[22px] w-px shrink-0 bg-border" />

      <div className="relative shrink-0" ref={popoverRef}>
        <button
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className={`flex h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${
            hasActiveFilters
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-text-muted hover:text-text"
          }`}
        >
          Filters
          {activeCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-white">
              {activeCount}
            </span>
          )}
          <svg
            className={`h-3 w-3 transition-transform ${showFilters ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showFilters && (
          <div
            role="dialog"
            aria-label="Filters"
            className="absolute left-0 top-full z-40 mt-1 w-[340px] rounded-xl border border-border bg-bg-card p-3 shadow-lg"
          >
            {chips.length > 0 && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                    Active
                  </span>
                  <button
                    onClick={clearFilters}
                    className="text-[12px] text-text-muted underline hover:text-text"
                  >
                    Clear all
                  </button>
                </div>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {chips.map((chip) => (
                    <FilterChip
                      key={chip.key}
                      label={chip.label}
                      colour={chip.colour}
                      initial={chip.initial}
                      isAssignee={chip.key === "assignee"}
                      onRemove={() => unset(chip.key)}
                    />
                  ))}
                </div>
                <div className="mb-3 h-px bg-border" />
              </>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Field label="Assignee">
                <select
                  value={filters.assignee}
                  onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
                  className={selectClass}
                >
                  <option value="">All assignees</option>
                  {assignees.map((a) => (
                    <option key={a.username} value={a.username}>
                      {a.username}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Category">
                <select
                  value={filters.category}
                  onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
                  className={selectClass}
                >
                  <option value="">All categories</option>
                  {(categories.length > 0 ? categories : CATEGORIES).map((c: Category) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Component">
                <select
                  value={filters.component}
                  onChange={(e) => setFilters((f) => ({ ...f, component: e.target.value }))}
                  className={selectClass}
                  disabled={components.length === 0}
                >
                  <option value="">All components</option>
                  {components.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Difficulty">
                <select
                  value={filters.difficulty}
                  onChange={(e) => setFilters((f) => ({ ...f, difficulty: e.target.value }))}
                  className={selectClass}
                >
                  <option value="">All sizes</option>
                  {DIFFICULTIES.map((d: Difficulty) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Priority">
                <select
                  value={filters.priority}
                  onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
                  className={selectClass}
                >
                  <option value="">All priorities</option>
                  {PRIORITIES.map((p: Priority) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Label">
                <select
                  value={filters.label}
                  onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}
                  className={selectClass}
                  disabled={labels.length === 0}
                >
                  <option value="">All labels</option>
                  {labels.map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Updated">
                <select
                  value={filters.dateRange}
                  onChange={(e) => setFilters((f) => ({ ...f, dateRange: e.target.value }))}
                  className={selectClass}
                >
                  {DATE_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        )}
      </div>

      {hasActiveFilters && (
        <button
          onClick={clearFilters}
          className="shrink-0 text-[12px] text-text-muted underline hover:text-text"
        >
          Clear
        </button>
      )}

      <div className="ml-auto flex h-[34px] shrink-0 items-center overflow-hidden rounded-lg border border-border bg-bg-card">
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="h-full bg-transparent px-2.5 text-[13px] text-text-muted focus:outline-none"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="h-full w-px bg-border" />
        <button
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          title={sortDir === "asc" ? "Ascending" : "Descending"}
          aria-label={sortDir === "asc" ? "Sort ascending" : "Sort descending"}
          className="h-full w-[30px] text-[13px] text-text-muted transition-colors hover:text-text"
        >
          {sortDir === "asc" ? "↑" : "↓"}
        </button>
      </div>

      {extraControls}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function FilterChip({
  label,
  colour,
  initial,
  isAssignee,
  onRemove,
}: {
  label: string;
  colour?: string;
  initial?: string;
  isAssignee?: boolean;
  onRemove: () => void;
}) {
  // A project category carries its own colour as data, the way column.color does;
  // everything else uses theme tokens
  const tinted = colour
    ? {
        backgroundColor: `color-mix(in srgb, ${colour} 15%, transparent)`,
        color: colour,
      }
    : undefined;

  return (
    <span
      style={tinted}
      className={`flex h-[26px] items-center gap-1 rounded-full pl-2.5 pr-1.5 text-[12px] font-medium ${
        tinted
          ? ""
          : isAssignee
            ? "bg-primary/15 text-primary"
            : "bg-bg-input text-text-muted"
      }`}
    >
      {initial && (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/25 text-[9px] font-semibold">
          {initial}
        </span>
      )}
      <span className="max-w-[9rem] truncate">{label}</span>
      <button
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-black/10 text-[10px] leading-none transition-opacity hover:opacity-70"
      >
        ×
      </button>
    </span>
  );
}

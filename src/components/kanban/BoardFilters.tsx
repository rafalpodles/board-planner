"use client";

import { useState, useEffect } from "react";
import {
  ApiTask,
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
}

interface BoardFiltersProps {
  tasks: ApiTask[];
  components: string[];
  onFilter: (filtered: ApiTask[]) => void;
}

export function BoardFilters({ tasks, components, onFilter }: BoardFiltersProps) {
  const [filters, setFilters] = useState<Filters>({
    search: "",
    assignee: "",
    component: "",
    category: "",
    difficulty: "",
  });
  const [sortField, setSortField] = useState<SortField>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showFilters, setShowFilters] = useState(false);

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

  const hasActiveFilters = filters.assignee || filters.component || filters.category || filters.difficulty;

  useEffect(() => {
    let result = tasks;

    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter((t) => t.title.toLowerCase().includes(q));
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
  }, [filters, tasks, sortField, sortDir]);

  function clearFilters() {
    setFilters({ search: "", assignee: "", component: "", category: "", difficulty: "" });
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
        </div>
      )}
    </div>
  );
}

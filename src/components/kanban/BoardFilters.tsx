"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ApiTask, ApiCustomField,
  ApiProjectCategory,
  CATEGORIES,
  PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  SORT_OPTIONS,
  BOARD_SORT_FIELDS,
  SortField, SortKey,
  SortDir,
  Category,
  Priority,
  defaultSortDir
} from "@/types";
import { categoryColor } from "@/lib/category-colors";
import { SortContext, sortTasks } from "@/lib/task-sort";
import { ListColumnId } from "@/lib/list-columns";
import { ColumnPicker } from "./ColumnPicker";
import {
  BoardFilterValues,
  PersistedBoardFilters,
  EMPTY_FILTERS,
  countActiveFilters,
  migratePersistedFilters,
  isFieldFilterSet,
  UNASSIGNED,
  type FieldFilter,
  type BuiltInFilterKey,
} from "@/lib/board-filters-state";
import {
  activeFields,
  isOptionField,
  matchesAllFieldFilters,
  orderedOptions,
  sortedFields,
} from "@/lib/custom-fields";

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
  state: PersistedBoardFilters
) {
  try {
    localStorage.setItem(`board-filters:${projectId}`, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable
  }
}

interface BoardFiltersProps {
  tasks: ApiTask[];
  categories?: string[];
  projectKey?: string;
  projectId: string;
  currentUsername?: string;
  projectCategories?: ApiProjectCategory[];
  extraControls?: React.ReactNode;
  /** Sort is owned above this component so the list view's column headers and
      this dropdown drive the same value */
  sortField: SortKey;
  sortDir: SortDir;
  onSortChange: (field: SortKey, dir: SortDir) => void;
  /** Which fields the dropdown offers; the current value is always included */
  sortFields?: SortField[];
  sortContext?: SortContext;
  hiddenColumns?: ListColumnId[];
  customFields?: ApiCustomField[];
  onHiddenColumnsChange?: (hidden: ListColumnId[]) => void;
  onFilter: (filtered: ApiTask[]) => void;
}

export function BoardFilters({
  tasks,
  categories = [],
  projectKey,
  projectId,
  currentUsername,
  projectCategories,
  extraControls,
  sortField,
  sortDir,
  onSortChange,
  sortFields = BOARD_SORT_FIELDS,
  sortContext,
  hiddenColumns,
  onHiddenColumnsChange,
  onFilter,
  customFields = [],
}: BoardFiltersProps) {
  const [initialized, setInitialized] = useState(false);
  const [filters, setFilters] = useState<Filters>({ search: "", ...EMPTY_FILTERS });
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
    const state = migratePersistedFilters(raw, currentUsername, customFields);
    setFilters((f) => ({ ...f, ...state.filters }));
    onSortChange(state.sortField, state.sortDir);
    onHiddenColumnsChange?.(state.hiddenColumns);
    setShowFilters(state.showFilters);
    setInitialized(true);
    // onSortChange is the owner's setter; re-running on its identity would
    // re-hydrate over whatever the user has since chosen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, currentUsername]);

  const persistState = useCallback(() => {
    const { search: _search, ...rest } = filters;
    void _search;
    savePersistedState(projectId, {
      filters: rest,
      sortField,
      sortDir,
      showFilters,
      hiddenColumns: hiddenColumns ?? [],
    });
  }, [projectId, filters, sortField, sortDir, showFilters, hiddenColumns]);

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
    if (filters.assignee === UNASSIGNED) {
      result = result.filter((t) => !t.assignee);
    } else if (filters.assignee) {
      result = result.filter(
        (t) =>
          t.assignee &&
          typeof t.assignee === "object" &&
          t.assignee.username === filters.assignee
      );
    }
    if (filters.category) {
      result = result.filter((t) => t.category === filters.category);
    }
    if (filters.priority) {
      result = result.filter((t) => t.priority === filters.priority);
    }
    if (Object.keys(filters.fields || {}).length) {
      result = result.filter((t) =>
        matchesAllFieldFilters(t.customFieldValues, filters.fields, customFields)
      );
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

    result = sortTasks(result, sortField, sortDir, sortContext);

    onFilter(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, tasks, sortField, sortDir, sortContext, currentUsername, projectKey]);

  function clearFilters() {
    setFilters((f) => ({ ...EMPTY_FILTERS, search: f.search }));
  }

  function unset(key: BuiltInFilterKey) {
    setFilters((f) => ({ ...f, [key]: "" }));
  }

  // An option field with no options renders a picker whose only entry is "All", so it
  // filters nothing. Every other type carries its own values — a checkbox is yes/no,
  // and text, number and date are typed in.
  const filterableFields = sortedFields(activeFields(customFields)).filter(
    (f) => f.filterable && (!isOptionField(f) || orderedOptions(f).length > 0)
  );

  function fieldFilter(fieldId: string): FieldFilter {
    return filters.fields?.[fieldId] ?? {};
  }

  function clearFieldFilter(fieldId: string) {
    setFilters((f) => {
      const fields = { ...(f.fields ?? {}) };
      delete fields[fieldId];
      return { ...f, fields };
    });
  }

  function setFieldFilter(fieldId: string, patch: FieldFilter) {
    setFilters((f) => {
      const next = { ...(f.fields?.[fieldId] ?? {}), ...patch };
      const fields = { ...(f.fields ?? {}) };
      if (isFieldFilterSet(next)) fields[fieldId] = next;
      else delete fields[fieldId];
      return { ...f, fields };
    });
  }

  const chips: {
    key: BuiltInFilterKey | string;
    label: string;
    colour?: string;
    initial?: string;
    fieldId?: string;
  }[] =
    [];
  if (filters.assignee) {
    chips.push({
      key: "assignee",
      label: filters.assignee === UNASSIGNED ? "Unassigned" : filters.assignee,
      initial:
        filters.assignee === UNASSIGNED ? "–" : filters.assignee.charAt(0).toUpperCase(),
    });
  }
  if (filters.category) {
    chips.push({
      key: "category",
      label: filters.category,
      colour: categoryColor(projectCategories, filters.category) || undefined,
    });
  }
  if (filters.priority) {
    chips.push({ key: "priority", label: PRIORITY_LABELS[filters.priority as Priority] });
  }
  if (filters.dateRange) {
    chips.push({
      key: "dateRange",
      label: DATE_PRESETS.find((p) => p.value === filters.dateRange)?.label ?? filters.dateRange,
    });
  }

  // Field chips carry the field's name, because "5" on its own says nothing
  for (const field of filterableFields) {
    const filter = filters.fields?.[field._id];
    if (!isFieldFilterSet(filter)) continue;
    const option = orderedOptions(field).find((o) => o.id === filter?.value);
    const range = [filter?.from, filter?.to];
    const label = option
      ? `${field.name}: ${option.value}`
      : filter?.value
        ? `${field.name}: ${filter.value}`
        : `${field.name}: ${range[0] || "…"}–${range[1] || "…"}`;
    chips.push({ key: `field:${field._id}`, label, colour: option?.color, fieldId: field._id });
  }

  const selectClass =
    "focus-ring h-8 w-full rounded-lg border border-border bg-bg-input px-2 text-[12px] text-text";

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
          className="focus-ring h-[34px] w-full rounded-lg border border-border bg-bg-card pl-8 pr-2.5 text-[13px] text-text placeholder:text-text-muted"
        />
      </div>

      <div className="h-[22px] w-px shrink-0 bg-border" />

      <div className="relative shrink-0" ref={popoverRef}>
        <button
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className={`focus-ring flex h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${
            hasActiveFilters
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-text-muted hover:text-text"
          }`}
        >
          Filters
          {activeCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-solid px-1 text-[10px] font-bold text-white">
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
                    className="focus-ring rounded text-[12px] text-text-muted underline hover:text-text"
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
                      onRemove={() =>
                        chip.fieldId
                          ? clearFieldFilter(chip.fieldId)
                          : unset(chip.key as BuiltInFilterKey)
                      }
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
                  <option value={UNASSIGNED}>Unassigned</option>
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

            {filterableFields.length > 0 && (
              <>
                <div className="my-3 h-px bg-border" />
                <div className="grid grid-cols-2 gap-2">
                  {filterableFields.map((field) => (
                    <Field key={field._id} label={field.name}>
                      {field.fieldType === "number" || field.fieldType === "date" ? (
                        // From/to rather than one box: a range is what people want from
                        // a number, and one input cannot express it
                        <div className="flex items-center gap-1">
                          <input
                            type={field.fieldType === "date" ? "date" : "number"}
                            value={fieldFilter(field._id).from ?? ""}
                            onChange={(e) => setFieldFilter(field._id, { from: e.target.value })}
                            aria-label={`${field.name} from`}
                            placeholder="from"
                            className={`${selectClass} min-w-0`}
                          />
                          <input
                            type={field.fieldType === "date" ? "date" : "number"}
                            value={fieldFilter(field._id).to ?? ""}
                            onChange={(e) => setFieldFilter(field._id, { to: e.target.value })}
                            aria-label={`${field.name} to`}
                            placeholder="to"
                            className={`${selectClass} min-w-0`}
                          />
                        </div>
                      ) : field.fieldType === "text" ? (
                        <input
                          value={fieldFilter(field._id).value ?? ""}
                          onChange={(e) => setFieldFilter(field._id, { value: e.target.value })}
                          aria-label={field.name}
                          placeholder="contains…"
                          className={selectClass}
                        />
                      ) : (
                        <select
                          value={fieldFilter(field._id).value ?? ""}
                          onChange={(e) => setFieldFilter(field._id, { value: e.target.value })}
                          aria-label={field.name}
                          className={selectClass}
                        >
                          <option value="">All</option>
                          {field.fieldType === "checkbox" ? (
                            <>
                              <option value="true">Yes</option>
                              <option value="false">No</option>
                            </>
                          ) : (
                            orderedOptions(field).map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.value}
                              </option>
                            ))
                          )}
                        </select>
                      )}
                    </Field>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {hasActiveFilters && (
        <button
          onClick={clearFilters}
          className="focus-ring shrink-0 rounded text-[12px] text-text-muted underline hover:text-text"
        >
          Clear
        </button>
      )}

      <div className="ml-auto flex h-[34px] shrink-0 items-center overflow-hidden rounded-lg border border-border bg-bg-card">
        <select
          value={sortField}
          aria-label="Sort tasks by"
          onChange={(e) => {
            const next = e.target.value as SortField;
            onSortChange(next, defaultSortDir(next));
          }}
          className="focus-ring-inset h-full rounded-l-lg bg-transparent px-2.5 text-[13px] text-text-muted"
        >
          {SORT_OPTIONS.filter(
            (o) => sortFields.includes(o.value) || o.value === sortField
          ).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="h-full w-px bg-border" />
        <button
          // Manual order is the order people dragged the rows into; reversing it
          // would also invert what a drag means, since the list reindexes on drop
          disabled={sortField === "manual"}
          onClick={() => onSortChange(sortField, sortDir === "asc" ? "desc" : "asc")}
          title={
            sortField === "manual"
              ? "Manual order has no direction"
              : sortDir === "asc"
                ? "Ascending"
                : "Descending"
          }
          aria-label={sortDir === "asc" ? "Sort ascending" : "Sort descending"}
          className="focus-ring-inset h-full w-[30px] rounded-r-lg text-[13px] text-text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-40"
        >
          {sortDir === "asc" ? "↑" : "↓"}
        </button>
      </div>

      {onHiddenColumnsChange && (
        <ColumnPicker
          hidden={hiddenColumns ?? []}
          onChange={onHiddenColumnsChange}
          customFields={customFields}
        />
      )}

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
        className="focus-ring flex h-[15px] w-[15px] items-center justify-center rounded-full bg-black/10 text-[10px] leading-none transition-opacity hover:opacity-70"
      >
        ×
      </button>
    </span>
  );
}

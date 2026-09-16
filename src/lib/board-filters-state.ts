import { ApiCustomField, COLUMN_ROLES, ColumnRole, ROLE_LABELS, SortDir, SortField, SortKey } from "@/types";
import { AnyColumn, effectiveColumns } from "./columns";
import { ListColumnId, defaultHidden, sanitizeHidden } from "./list-columns";

/** Range for number and date fields; `value` carries every other type */
export interface FieldFilter {
  value?: string;
  from?: string;
  to?: string;
}

export interface BoardFilterValues {
  /** Keyed by field id, so the built-in keys stay a closed set */
  fields: Record<string, FieldFilter>;
  assignee: string;
  category: string;
  priority: string;
  /** A ColumnRole, or UNFILED. Never a column id — see statusOptions */
  status: string;
  dateRange: string;
}

export interface PersistedBoardFilters {
  filters: BoardFilterValues;
  sortField: SortKey;
  sortDir: SortDir;
  showFilters: boolean;
  hiddenColumns: ListColumnId[];
}

/**
 * Sentinel for "has no assignee" in the assignee filter. Not "" — that already means
 * "any assignee" — and the "@" keeps it out of reach of a real username.
 */
export const UNASSIGNED = "@none";

/**
 * Sentinel for "sitting in a column this board no longer has", which a task keeps on
 * indefinitely once somebody deletes the column it was in. It has no role to match, so
 * every role filter would hide it and no filter would ever show it on its own.
 */
export const UNFILED = "@unfiled";

export const EMPTY_FILTERS: BoardFilterValues = {
  fields: {},
  assignee: "",
  category: "",
  priority: "",
  status: "",
  dateRange: "",
};

/** The built-in keys only — `fields` is a map and is counted separately */
export type BuiltInFilterKey = Exclude<keyof BoardFilterValues, "fields">;

export const FILTER_KEYS = Object.keys(EMPTY_FILTERS).filter(
  (k) => k !== "fields"
) as BuiltInFilterKey[];

export function isFieldFilterSet(filter: FieldFilter | undefined): boolean {
  return !!(filter?.value || filter?.from || filter?.to);
}

/** Drops filters whose field is gone or archived, so none survives where it cannot be cleared */
export function sanitizeFieldFilters(
  raw: unknown,
  customFields: ApiCustomField[]
): Record<string, FieldFilter> {
  if (!raw || typeof raw !== "object") return {};
  const live = new Set(customFields.filter((f) => !f.archived && f.filterable).map((f) => f._id));
  const result: Record<string, FieldFilter> = {};
  for (const [id, filter] of Object.entries(raw as Record<string, FieldFilter>)) {
    if (live.has(id) && isFieldFilterSet(filter)) result[id] = filter;
  }
  return result;
}

/**
 * What the status filter offers. Roles, not column ids: two boards agree on roles and on
 * nothing else (BP-128), so a board whose columns were renamed or rebuilt still filters.
 * Ordered by the board rather than by the enum, so the list reads down the columns.
 *
 * Several columns commonly share one role — the default board has three review columns —
 * so an option names the role and covers all of them.
 */
export function statusOptions(
  columns: AnyColumn[] | null | undefined,
  tasks: { status: string }[] = []
): { value: string; label: string }[] {
  const live = effectiveColumns(columns);
  const seen = new Set<ColumnRole>();
  const options: { value: string; label: string }[] = [];
  for (const column of live) {
    if (seen.has(column.role)) continue;
    seen.add(column.role);
    options.push({ value: column.role, label: ROLE_LABELS[column.role].label });
  }
  const ids = new Set(live.map((c) => c.id));
  if (tasks.some((t) => !ids.has(t.status))) {
    options.push({ value: UNFILED, label: "No column" });
  }
  return options;
}

export function matchesStatusFilter(
  status: string,
  filter: string,
  columns: AnyColumn[] | null | undefined
): boolean {
  if (!filter) return true;
  const column = effectiveColumns(columns).find((c) => c.id === status);
  return column ? column.role === filter : filter === UNFILED;
}

const DEFAULTS: PersistedBoardFilters = {
  filters: EMPTY_FILTERS,
  sortField: "manual",
  sortDir: "asc",
  showFilters: false,
  hiddenColumns: [],
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The standalone "My tasks" toggle became filters.assignee. A stored myTasks:true
// has to carry over, or everyone using it silently loses their filter on upgrade.
export function migratePersistedFilters(
  raw: unknown,
  currentUsername?: string,
  // Passed so a hidden project-field column survives a reload, and an archived
  // field's entry is dropped instead of lingering where nobody can clear it
  customFields: ApiCustomField[] = [],
  // Undefined means "not known yet" and leaves the filter alone; a list means a name
  // outside it was renamed away and the filter has to go with it
  categories?: string[]
): PersistedBoardFilters {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULTS, hiddenColumns: defaultHidden(customFields) };
  }
  const blob = raw as Record<string, unknown>;
  const stored = (blob.filters ?? {}) as Record<string, unknown>;

  const filters = { ...EMPTY_FILTERS };
  for (const key of FILTER_KEYS) filters[key] = str(stored[key]);

  if (categories && filters.category && !categories.includes(filters.category)) {
    filters.category = "";
  }

  // A stored value from a build that spelled roles differently would filter every task away
  // with no option in the picker to clear it
  if (filters.status !== UNFILED && !COLUMN_ROLES.includes(filters.status as ColumnRole)) {
    filters.status = "";
  }

  // An explicit assignee is a later, more specific choice than the legacy toggle
  if (blob.myTasks === true && !filters.assignee && currentUsername) {
    filters.assignee = currentUsername;
  }

  filters.fields = sanitizeFieldFilters(
    (blob.filters as Record<string, unknown> | undefined)?.fields,
    customFields
  );

  return {
    filters,
    sortField: (str(blob.sortField) || DEFAULTS.sortField) as SortField,
    sortDir: str(blob.sortDir) === "desc" ? "desc" : "asc",
    showFilters: blob.showFilters === true,
    hiddenColumns: sanitizeHidden(blob.hiddenColumns, customFields),
  };
}

export function countActiveFilters(filters: BoardFilterValues): number {
  const builtIn = FILTER_KEYS.filter((key) => filters[key] !== "").length;
  const fields = Object.values(filters.fields || {}).filter(isFieldFilterSet).length;
  return builtIn + fields;
}

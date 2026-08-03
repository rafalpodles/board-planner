import { ApiCustomField, SortDir, SortField, SortKey } from "@/types";
import { ListColumnId, DEFAULT_HIDDEN, sanitizeHidden } from "./list-columns";

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
  component: string;
  category: string;
  difficulty: string;
  priority: string;
  label: string;
  dateRange: string;
}

export interface PersistedBoardFilters {
  filters: BoardFilterValues;
  sortField: SortKey;
  sortDir: SortDir;
  showFilters: boolean;
  hiddenColumns: ListColumnId[];
}

export const EMPTY_FILTERS: BoardFilterValues = {
  fields: {},
  assignee: "",
  component: "",
  category: "",
  difficulty: "",
  priority: "",
  label: "",
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

const DEFAULTS: PersistedBoardFilters = {
  filters: EMPTY_FILTERS,
  sortField: "manual",
  sortDir: "asc",
  showFilters: false,
  hiddenColumns: DEFAULT_HIDDEN,
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
  customFields: ApiCustomField[] = []
): PersistedBoardFilters {
  if (!raw || typeof raw !== "object") return DEFAULTS;
  const blob = raw as Record<string, unknown>;
  const stored = (blob.filters ?? {}) as Record<string, unknown>;

  const filters = { ...EMPTY_FILTERS };
  for (const key of FILTER_KEYS) filters[key] = str(stored[key]);

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

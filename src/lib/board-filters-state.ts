import { ApiCustomField, SortDir, SortField, SortKey } from "@/types";
import { ListColumnId, defaultHidden, sanitizeHidden } from "./list-columns";

export interface FieldFilter {
  value?: string;
  from?: string;
  to?: string;
}

export interface BoardFilterValues {
  fields: Record<string, FieldFilter>;
  assignee: string;
  category: string;
  priority: string;
  dateRange: string;
}

export interface PersistedBoardFilters {
  filters: BoardFilterValues;
  sortField: SortKey;
  sortDir: SortDir;
  showFilters: boolean;
  hiddenColumns: ListColumnId[];
}

export const UNASSIGNED = "@none";

export const EMPTY_FILTERS: BoardFilterValues = {
  fields: {},
  assignee: "",
  category: "",
  priority: "",
  dateRange: "",
};

export type BuiltInFilterKey = Exclude<keyof BoardFilterValues, "fields">;

export const FILTER_KEYS = Object.keys(EMPTY_FILTERS).filter(
  (k) => k !== "fields"
) as BuiltInFilterKey[];

export function isFieldFilterSet(filter: FieldFilter | undefined): boolean {
  return !!(filter?.value || filter?.from || filter?.to);
}

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
  hiddenColumns: [],
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function migratePersistedFilters(
  raw: unknown,
  currentUsername?: string,
  customFields: ApiCustomField[] = [],
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

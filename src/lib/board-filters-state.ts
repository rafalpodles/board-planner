import { SortDir, SortField } from "@/types";
import { ListColumnId, DEFAULT_HIDDEN, sanitizeHidden } from "./list-columns";

export interface BoardFilterValues {
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
  sortField: SortField;
  sortDir: SortDir;
  showFilters: boolean;
  hiddenColumns: ListColumnId[];
}

export const EMPTY_FILTERS: BoardFilterValues = {
  assignee: "",
  component: "",
  category: "",
  difficulty: "",
  priority: "",
  label: "",
  dateRange: "",
};

export const FILTER_KEYS = Object.keys(EMPTY_FILTERS) as (keyof BoardFilterValues)[];

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
  currentUsername?: string
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

  return {
    filters,
    sortField: (str(blob.sortField) || DEFAULTS.sortField) as SortField,
    sortDir: str(blob.sortDir) === "desc" ? "desc" : "asc",
    showFilters: blob.showFilters === true,
    hiddenColumns: sanitizeHidden(blob.hiddenColumns),
  };
}

export function countActiveFilters(filters: BoardFilterValues): number {
  return FILTER_KEYS.filter((key) => filters[key] !== "").length;
}

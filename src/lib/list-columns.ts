import { SortField } from "@/types";

/** Column ids double as sort fields, so hiding one also hides its sort control */
export type ListColumnId = Extract<
  SortField,
  | "key"
  | "title"
  | "status"
  | "assignee"
  | "priority"
  | "sprint"
  | "difficulty"
  | "category"
  | "component"
  | "dueDate"
  | "updatedAt"
>;

export interface ListColumnDef {
  id: ListColumnId;
  label: string;
  /** Cannot be hidden — a row with no title is not a row */
  fixed?: boolean;
}

export const LIST_COLUMNS: ListColumnDef[] = [
  { id: "key", label: "Key", fixed: true },
  { id: "title", label: "Title", fixed: true },
  { id: "status", label: "Status" },
  { id: "assignee", label: "Assignee" },
  { id: "priority", label: "Priority" },
  { id: "sprint", label: "Sprint" },
  { id: "difficulty", label: "Difficulty" },
  { id: "category", label: "Category" },
  { id: "component", label: "Component" },
  { id: "dueDate", label: "Due" },
  { id: "updatedAt", label: "Updated" },
];

export const HIDEABLE_COLUMNS = LIST_COLUMNS.filter((c) => !c.fixed);

/** Every column on by default, which is what the list showed before this existed */
export const DEFAULT_HIDDEN: ListColumnId[] = [];

export function isColumnVisible(id: ListColumnId, hidden: ListColumnId[]): boolean {
  const column = LIST_COLUMNS.find((c) => c.id === id);
  if (column?.fixed) return true;
  return !hidden.includes(id);
}

export function toggleColumn(hidden: ListColumnId[], id: ListColumnId): ListColumnId[] {
  const column = LIST_COLUMNS.find((c) => c.id === id);
  if (column?.fixed) return hidden;
  return hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
}

/** Drops ids that are unknown or fixed, so a stale stored blob cannot hide the title */
export function sanitizeHidden(raw: unknown): ListColumnId[] {
  if (!Array.isArray(raw)) return DEFAULT_HIDDEN;
  const hideable = new Set(HIDEABLE_COLUMNS.map((c) => c.id as string));
  return [...new Set(raw.filter((id): id is ListColumnId => typeof id === "string" && hideable.has(id)))];
}

export function visibleCount(hidden: ListColumnId[]): number {
  return LIST_COLUMNS.length - sanitizeHidden(hidden).length;
}

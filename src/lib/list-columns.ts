import { ApiCustomField, SortField } from "@/types";
import { activeFields, sortedFields } from "./custom-fields";

/**
 * A column id is either a built-in sort field or a project field's id. It stopped
 * being a closed union in CP-212: a project can add a column, so the set is a
 * function of the project rather than a constant.
 */
export type ListColumnId = string;

export type BuiltInColumnId = Extract<
  SortField,
  | "key"
  | "title"
  | "status"
  | "assignee"
  | "priority"
  | "sprint"
  | "category"
  | "dueDate"
  | "updatedAt"
>;

export interface ListColumnDef {
  id: ListColumnId;
  label: string;
  /** Cannot be hidden — a row with no title is not a row */
  fixed?: boolean;
  /** Set for a project field, so the picker can group the two apart */
  field?: ApiCustomField;
}

export const BUILT_IN_COLUMNS: ListColumnDef[] = [
  { id: "key", label: "Key", fixed: true },
  { id: "title", label: "Title", fixed: true },
  { id: "status", label: "Status" },
  { id: "assignee", label: "Assignee" },
  { id: "priority", label: "Priority" },
  { id: "sprint", label: "Sprint" },
  { id: "category", label: "Category" },
  { id: "dueDate", label: "Due" },
  { id: "updatedAt", label: "Updated" },
];

/** Built-in columns first, then whatever the project marked `showInList` */
export function listColumns(fields: ApiCustomField[] = []): ListColumnDef[] {
  const fieldColumns = sortedFields(activeFields(fields))
    .filter((f) => f.showInList)
    .map((f) => ({ id: f._id, label: f.name, field: f }));
  return [...BUILT_IN_COLUMNS, ...fieldColumns];
}

export function hideableColumns(fields: ApiCustomField[] = []): ListColumnDef[] {
  return listColumns(fields).filter((c) => !c.fixed);
}

const DEFAULT_HIDDEN_BUILT_INS: ListColumnId[] = ["category", "dueDate", "updatedAt"];

/**
 * Off by default. Every column on left a dozen of them fighting over the width, which
 * squeezed the title to a few characters and pushed the list into sideways scrolling.
 * Category duplicates what the row tint already says, the two dates are rarely why
 * someone opens the board, and a project field is by definition niche. The picker
 * turns any of them back on.
 */
export function defaultHidden(fields: ApiCustomField[] = []): ListColumnId[] {
  return [
    ...DEFAULT_HIDDEN_BUILT_INS,
    ...listColumns(fields)
      .filter((c) => c.field)
      .map((c) => c.id),
  ];
}

export function isColumnVisible(id: ListColumnId, hidden: ListColumnId[]): boolean {
  const column = BUILT_IN_COLUMNS.find((c) => c.id === id);
  if (column?.fixed) return true;
  return !hidden.includes(id);
}

export function toggleColumn(hidden: ListColumnId[], id: ListColumnId): ListColumnId[] {
  const column = BUILT_IN_COLUMNS.find((c) => c.id === id);
  if (column?.fixed) return hidden;
  return hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
}

/** Drops ids that are unknown or fixed, so a stale stored blob cannot hide the title */
/**
 * Drops ids that are no longer columns. Passing the project's fields is what stops
 * an archived field from leaving a hidden-column entry nobody can see or clear.
 */
export function sanitizeHidden(raw: unknown, fields: ApiCustomField[] = []): ListColumnId[] {
  if (!Array.isArray(raw)) return defaultHidden(fields);
  const hideable = new Set(hideableColumns(fields).map((c) => c.id));
  return [...new Set(raw.filter((id): id is ListColumnId => typeof id === "string" && hideable.has(id)))];
}

export function visibleCount(hidden: ListColumnId[], fields: ApiCustomField[] = []): number {
  return listColumns(fields).length - sanitizeHidden(hidden, fields).length;
}

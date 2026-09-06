import { ColumnRole, DEFAULT_PROJECT_COLUMNS, IProjectColumn } from "@/types";

export type AnyColumn = {
  id: string;
  label: string;
  color: string;
  role: ColumnRole;
  order: number;
  triggersPmReview?: boolean;
};

export function effectiveColumns(columns: AnyColumn[] | null | undefined): AnyColumn[] {
  if (!columns || columns.length === 0) {
    return DEFAULT_PROJECT_COLUMNS;
  }
  return [...columns].sort((a, b) => a.order - b.order);
}

type ProjectColumn = IProjectColumn | Omit<IProjectColumn, "_id">;
type HasColumns = { columns?: IProjectColumn[] | null };

export function getProjectColumns(project: HasColumns | null | undefined): ProjectColumn[] {
  return effectiveColumns(project?.columns) as ProjectColumn[];
}

export function getColumnIds(project: HasColumns | null | undefined): string[] {
  return getProjectColumns(project).map((c) => c.id);
}

export function roleOf(
  project: HasColumns | null | undefined,
  statusId: string
): ColumnRole | undefined {
  return getProjectColumns(project).find((c) => c.id === statusId)?.role;
}

export function defaultStatusFor(project: HasColumns | null | undefined): string {
  const columns = getProjectColumns(project);
  const landing =
    columns.find((c) => c.role === "backlog") ??
    columns.find((c) => c.role === "approved") ??
    columns.find((c) => c.role !== "done") ??
    columns[0];
  return landing.id;
}

type HasAnyColumns = { columns?: AnyColumn[] | null };

export function columnIdsWithRole(
  project: HasAnyColumns | null | undefined,
  role: ColumnRole
): string[] {
  return effectiveColumns(project?.columns)
    .filter((c) => c.role === role)
    .map((c) => c.id);
}

export function mergedReviewDestination(
  project: HasAnyColumns | null | undefined,
  status: string
): string | undefined {
  const review = effectiveColumns(project?.columns).filter((c) => c.role === "review");
  const from = review.findIndex((c) => c.id === status);
  if (from < 0 || review[from].triggersPmReview) return undefined;
  return review.slice(from + 1).find((c) => !c.triggersPmReview)?.id;
}

export function columnFor(
  project: HasAnyColumns | null | undefined,
  statusId: string
): AnyColumn | undefined {
  return effectiveColumns(project?.columns).find((c) => c.id === statusId);
}

export const ROLE_ORDER: Record<ColumnRole, number> = {
  active: 0,
  blocked: 1,
  review: 2,
  approved: 3,
  backlog: 4,
  done: 5,
};

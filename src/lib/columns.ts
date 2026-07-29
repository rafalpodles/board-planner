import { ColumnRole, DEFAULT_PROJECT_COLUMNS, IProjectColumn } from "@/types";

// Structural shape shared by IProjectColumn (server) and ApiProjectColumn (client)
export type AnyColumn = {
  id: string;
  label: string;
  color: string;
  role: ColumnRole;
  order: number;
  triggersPmReview?: boolean;
};

// Falls back to the built-in seven for documents created before the seeding migration
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
  return columns.find((c) => c.role === "backlog")?.id ?? columns[0].id;
}

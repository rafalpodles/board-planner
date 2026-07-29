import { ColumnRole, DEFAULT_PROJECT_COLUMNS, IProjectColumn } from "@/types";

type ProjectColumn = IProjectColumn | Omit<IProjectColumn, "_id">;
type HasColumns = { columns?: IProjectColumn[] | null };

// Falls back to the built-in seven for documents created before the seeding migration
export function getProjectColumns(project: HasColumns | null | undefined): ProjectColumn[] {
  const columns = project?.columns;
  if (!columns || columns.length === 0) {
    return DEFAULT_PROJECT_COLUMNS;
  }
  return [...columns].sort((a, b) => a.order - b.order);
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

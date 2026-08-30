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

// A board need not have a backlog column, and columns[0] on such a board can be a done one — where
// a task is born already finished. A recurring occurrence landing there ends the series silently,
// because creation never runs the status-change side effects that would mint the one after it.
export function defaultStatusFor(project: HasColumns | null | undefined): string {
  const columns = getProjectColumns(project);
  const landing =
    columns.find((c) => c.role === "backlog") ??
    columns.find((c) => c.role === "approved") ??
    columns.find((c) => c.role !== "done") ??
    columns[0];
  return landing.id;
}

// Which column ids carry a role, for the queries that used to compare against a literal id.
// A project that renamed or rebuilt its board has ids nothing hardcoded can match — and the query
// that mattered most, carrying unfinished tasks out of a closing sprint, then dragged finished
// work into the next one because its column was not literally called "done".
// Structural, so the board page and the API can share it: the client's columns carry no _id and
// the two types are otherwise the same shape.
type HasAnyColumns = { columns?: AnyColumn[] | null };

export function columnIdsWithRole(
  project: HasAnyColumns | null | undefined,
  role: ColumnRole
): string[] {
  return effectiveColumns(project?.columns)
    .filter((c) => c.role === role)
    .map((c) => c.id);
}

// Where a merged pull request or merge request sends a task, or undefined if it sends it nowhere.
// Only the FIRST review column advances, and it advances to the LAST one. Both halves are load-bearing:
// the default board has three review columns (in_review, needs_human_review, ready_to_test), so
// "the next review column" lands merged work in the queue that exists for a human to look at, and
// lets a merged branch pull a task back OUT of that queue. A board with one review column, or none,
// transitions nothing.
export function mergedReviewDestination(
  project: HasAnyColumns | null | undefined,
  status: string
): string | undefined {
  const reviewIds = columnIdsWithRole(project, "review");
  const destination = reviewIds[reviewIds.length - 1];
  return status === reviewIds[0] && destination !== status ? destination : undefined;
}

// The column a task is sitting in, or undefined if its status names no column the project has —
// which happens to a task left behind by a column somebody deleted.
export function columnFor(
  project: HasAnyColumns | null | undefined,
  statusId: string
): AnyColumn | undefined {
  return effectiveColumns(project?.columns).find((c) => c.id === statusId);
}

// What a board means, rather than what its columns are called. Anything ordering work across
// projects has to compare these: two boards agree on roles and on nothing else.
export const ROLE_ORDER: Record<ColumnRole, number> = {
  active: 0,
  blocked: 1,
  review: 2,
  approved: 3,
  backlog: 4,
  done: 5,
};

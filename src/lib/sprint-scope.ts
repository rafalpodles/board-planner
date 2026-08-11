import { ApiSprint } from "@/types";
import { isObjectIdSegment } from "@/lib/urls";

export const ALL_TASKS = "all";
export const BACKLOG = "backlog";

// A scope this shallow check accepts is not guaranteed to name a sprint that exists —
// an id belonging to another project just returns no tasks — but it is guaranteed to
// never reach the tasks endpoint's Mongoose filter as something it can't cast
export function isSprintScopeShape(value: string): boolean {
  return value === ALL_TASKS || value === BACKLOG || isObjectIdSegment(value);
}

// Absent, empty, whitespace, or anything that cannot be a scope all mean the unscoped board
export function sprintScopeFromParam(param: string | null | undefined): string {
  const trimmed = param?.trim();
  if (!trimmed) return ALL_TASKS;
  return isSprintScopeShape(trimmed) ? trimmed : ALL_TASKS;
}

export function sprintScopeToQuery(scope: string): string {
  return scope === ALL_TASKS ? "" : `?sprint=${encodeURIComponent(scope)}`;
}

// null means "no scope segment in the subtitle" — either unscoped, or pointing at
// a sprint that no longer exists, where showing a raw id would be worse than nothing
export function sprintScopeLabel(scope: string, sprints: ApiSprint[]): string | null {
  if (scope === ALL_TASKS) return null;
  if (scope === BACKLOG) return "Backlog";
  return sprints.find((s) => s._id === scope)?.name ?? null;
}

// A task created while the board is scoped to a sprint must land in that sprint,
// or the server filter hides it the moment it is saved. "all" and "backlog" are
// modes rather than sprints, so they still mean no sprint.
export function sprintDefaultForNewTask(scope: string): string {
  return scope === ALL_TASKS || scope === BACKLOG ? "" : scope;
}

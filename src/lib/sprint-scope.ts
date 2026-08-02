import { ApiSprint } from "@/types";

export const ALL_TASKS = "all";
export const BACKLOG = "backlog";

// Absent, empty or whitespace all mean the unscoped board
export function sprintScopeFromParam(param: string | null | undefined): string {
  const trimmed = param?.trim();
  return trimmed ? trimmed : ALL_TASKS;
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

export function boardSubtitle(scopeLabel: string | null, taskCount: number): string {
  const parts = ["Board"];
  if (scopeLabel) parts.push(scopeLabel);
  parts.push(`${taskCount} ${taskCount === 1 ? "task" : "tasks"}`);
  return parts.join(" · ");
}

import { ApiSprint } from "@/types";
import { isObjectIdSegment } from "@/lib/urls";

export const ALL_TASKS = "all";
export const BACKLOG = "backlog";

export function isSprintScopeShape(value: string): boolean {
  return value === ALL_TASKS || value === BACKLOG || isObjectIdSegment(value);
}

export function sprintScopeFromParam(param: string | null | undefined): string {
  const trimmed = param?.trim();
  if (!trimmed) return ALL_TASKS;
  return isSprintScopeShape(trimmed) ? trimmed : ALL_TASKS;
}

export function sprintScopeToQuery(scope: string): string {
  return scope === ALL_TASKS ? "" : `?sprint=${encodeURIComponent(scope)}`;
}

export function sprintScopeLabel(scope: string, sprints: ApiSprint[]): string | null {
  if (scope === ALL_TASKS) return null;
  if (scope === BACKLOG) return "Backlog";
  return sprints.find((s) => s._id === scope)?.name ?? null;
}

export function sprintDefaultForNewTask(scope: string): string {
  return scope === ALL_TASKS || scope === BACKLOG ? "" : scope;
}

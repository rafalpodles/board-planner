import { ApiSprint } from "@/types";

export const OLDER_COMPLETED_THRESHOLD = 3;

const byStart = (a: ApiSprint, b: ApiSprint) => {
  if (!a.startDate && !b.startDate) return a._id.localeCompare(b._id);
  if (!a.startDate) return 1;
  if (!b.startDate) return -1;
  const dateCompare = a.startDate.localeCompare(b.startDate);
  return dateCompare || a._id.localeCompare(b._id);
};
const byEndDesc = (a: ApiSprint, b: ApiSprint) => {
  if (!a.endDate && !b.endDate) return b._id.localeCompare(a._id);
  if (!a.endDate) return 1;
  if (!b.endDate) return -1;
  const dateCompare = b.endDate.localeCompare(a.endDate);
  return dateCompare || b._id.localeCompare(a._id);
};
const byStartDesc = (a: ApiSprint, b: ApiSprint) => {
  if (!a.startDate && !b.startDate) return b._id.localeCompare(a._id);
  if (!a.startDate) return 1;
  if (!b.startDate) return -1;
  const dateCompare = b.startDate.localeCompare(a.startDate);
  return dateCompare || b._id.localeCompare(a._id);
};

export function sprintOptionLabel(sprint: ApiSprint): string {
  return `${sprint.name} · ${sprint.doneCount ?? 0}/${sprint.taskCount ?? 0}`;
}

export interface GroupedSprints {
  active: ApiSprint[];
  planned: ApiSprint[];
  completed: ApiSprint[];
  recentCompleted: ApiSprint[];
  olderCompleted: ApiSprint[];
}

export function groupSprints(sprints: ApiSprint[]): GroupedSprints {
  const active = sprints.filter((s) => s.status === "active").sort(byStartDesc);
  const planned = sprints.filter((s) => s.status === "planned").sort(byStart);
  const completed = sprints.filter((s) => s.status === "completed").sort(byEndDesc);
  return {
    active,
    planned,
    completed,
    recentCompleted: completed.slice(0, OLDER_COMPLETED_THRESHOLD),
    olderCompleted: completed.slice(OLDER_COMPLETED_THRESHOLD),
  };
}

export function defaultSprintId(sprints: ApiSprint[]): string | null {
  const { active, planned, completed } = groupSprints(sprints);
  return active[0]?._id ?? planned[0]?._id ?? completed[0]?._id ?? null;
}

export function resolveSelectedSprint(
  sprints: ApiSprint[],
  requested: string | null
): string | null {
  if (requested && sprints.some((s) => s._id === requested)) return requested;
  return defaultSprintId(sprints);
}

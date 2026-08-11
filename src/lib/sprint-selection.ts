import { ApiSprint } from "@/types";

export const OLDER_COMPLETED_THRESHOLD = 3;

const byStart = (a: ApiSprint, b: ApiSprint) => a.startDate.localeCompare(b.startDate);
const byEndDesc = (a: ApiSprint, b: ApiSprint) => b.endDate.localeCompare(a.endDate);

export interface GroupedSprints {
  active: ApiSprint[];
  planned: ApiSprint[];
  completed: ApiSprint[];
  recentCompleted: ApiSprint[];
  olderCompleted: ApiSprint[];
}

export function groupSprints(sprints: ApiSprint[]): GroupedSprints {
  const active = sprints.filter((s) => s.status === "active");
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

// "Most recent planned" reads as the sprint about to run, not the one furthest out
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

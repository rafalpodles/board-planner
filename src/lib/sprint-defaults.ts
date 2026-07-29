import { ApiSprint } from "@/types";

const DAY_MS = 86_400_000;
const FALLBACK_DURATION_DAYS = 14;

export function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(dateInput: string, days: number): string {
  const date = new Date(`${dateInput}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toDateInput(date);
}

export function daysBetween(startInput: string, endInput: string): number {
  const start = new Date(`${startInput}T00:00:00`).getTime();
  const end = new Date(`${endInput}T00:00:00`).getTime();
  return Math.round((end - start) / DAY_MS);
}

export function latestSprint(sprints: ApiSprint[]): ApiSprint | null {
  if (sprints.length === 0) return null;
  return sprints.reduce((latest, sprint) =>
    new Date(sprint.endDate) > new Date(latest.endDate) ? sprint : latest
  );
}

// "Sprint 1" → "Sprint 2". Empty when there is no trailing number to increment,
// so we never propose a duplicate of the previous name.
export function nextSprintName(sprints: ApiSprint[]): string {
  const latest = latestSprint(sprints);
  if (!latest) return "Sprint 1";
  const match = latest.name.match(/^(.*?)(\d+)(\D*)$/);
  if (!match) return "";
  return `${match[1]}${Number(match[2]) + 1}${match[3]}`;
}

export function nextSprintDates(
  sprints: ApiSprint[],
  today: Date
): { startDate: string; endDate: string } {
  const latest = latestSprint(sprints);
  if (!latest) {
    const start = toDateInput(today);
    return { startDate: start, endDate: addDays(start, FALLBACK_DURATION_DAYS) };
  }

  const previousStart = latest.startDate.substring(0, 10);
  const previousEnd = latest.endDate.substring(0, 10);
  const duration = Math.max(1, daysBetween(previousStart, previousEnd));
  // Chain onto the previous sprint, unless it already ended in the past
  const start = previousEnd > toDateInput(today) ? previousEnd : toDateInput(today);
  return { startDate: start, endDate: addDays(start, duration) };
}

export function overlappingSprint(
  sprints: ApiSprint[],
  startDate: string,
  endDate: string,
  excludeId?: string
): ApiSprint | null {
  return (
    sprints.find((sprint) => {
      if (sprint._id === excludeId) return false;
      const otherStart = sprint.startDate.substring(0, 10);
      const otherEnd = sprint.endDate.substring(0, 10);
      // Touching endpoints are intentional chaining, not an overlap
      return startDate < otherEnd && endDate > otherStart;
    }) ?? null
  );
}

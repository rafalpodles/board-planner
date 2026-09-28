import { toDateInput } from "./sprint-defaults";

const DAY_MS = 86_400_000;

export type DateOnly = string | Date;

// A picked day is stored as its UTC midnight; read in the viewer's zone it is the day before west of UTC
export function dateOnlyKey(value: DateOnly): string | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

export function formatDateOnly(value: DateOnly, options: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}

export function daysUntil(value: DateOnly, now: Date = new Date()): number {
  const key = dateOnlyKey(value);
  if (!key) return Number.NaN;
  return Math.round((Date.parse(key) - Date.parse(toDateInput(now))) / DAY_MS);
}

export type DueUrgency = "overdue" | "soon" | "later";

export function dueUrgency(value: DateOnly, now: Date = new Date()): DueUrgency {
  const days = daysUntil(value, now);
  if (days < 0) return "overdue";
  return days <= 2 ? "soon" : "later";
}

export const DUE_URGENCY_CLASS: Record<DueUrgency, string> = {
  overdue: "text-danger",
  soon: "text-warning",
  later: "text-text-muted",
};

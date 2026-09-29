import { toDateInput } from "./sprint-defaults";

const DAY_MS = 86_400_000;

export type DateOnly = string | Date;

// The day is read in UTC, where the date input stores it as midnight. A REST writer that sends a time
// of day keeps it, and its day is then the UTC one, which is the day the server's recurrence uses.
export function dateOnlyKey(value: DateOnly): string | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

export function formatDateOnly(value: DateOnly, options: Intl.DateTimeFormatOptions): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}

export function daysUntil(value: DateOnly, now: Date = new Date()): number {
  const key = dateOnlyKey(value);
  if (!key) return Number.NaN;
  return Math.round((Date.parse(key) - Date.parse(toDateInput(now))) / DAY_MS);
}

export type DueUrgency = "overdue" | "soon" | "later";

export function dueUrgency(value: DateOnly, now: Date = new Date()): DueUrgency | null {
  const days = daysUntil(value, now);
  if (Number.isNaN(days)) return null;
  if (days < 0) return "overdue";
  return days <= 2 ? "soon" : "later";
}

const DUE_URGENCY_CLASS: Record<DueUrgency, string> = {
  overdue: "text-danger",
  soon: "text-warning",
  later: "text-text-muted",
};

export function dueDateClass(value: DateOnly, now: Date = new Date()): string {
  const urgency = dueUrgency(value, now);
  return urgency ? DUE_URGENCY_CLASS[urgency] : "text-text-muted";
}

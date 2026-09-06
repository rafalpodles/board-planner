import { RecurrenceFrequency, RECURRENCE_FREQUENCIES } from "@/types";

export const MAX_RECURRENCE_INTERVAL = 365;

export interface NormalisedRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  anchorDay: number | null;
  endDate: Date | null;
}

export type RecurrenceResult =
  | { ok: true; value: NormalisedRecurrence | null }
  | { ok: false; error: string };

export function normaliseRecurrence(raw: unknown): RecurrenceResult {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Invalid recurrence — expected frequency and interval" };
  }

  const { frequency, interval, endDate } = raw as Record<string, unknown>;

  if (!RECURRENCE_FREQUENCIES.includes(frequency as RecurrenceFrequency)) {
    return {
      ok: false,
      error: `Invalid recurrence frequency "${String(frequency)}" — one of: ${RECURRENCE_FREQUENCIES.join(", ")}`,
    };
  }

  const every =
    typeof interval === "number" || typeof interval === "string" ? Number(interval) : NaN;
  if (!Number.isInteger(every) || every < 1 || every > MAX_RECURRENCE_INTERVAL) {
    return {
      ok: false,
      error: `Invalid recurrence interval "${String(interval)}" — a whole number between 1 and ${MAX_RECURRENCE_INTERVAL}`,
    };
  }

  let ends: Date | null = null;
  if (endDate !== null && endDate !== undefined && endDate !== "") {
    const parsed =
      typeof endDate === "string" || typeof endDate === "number" || endDate instanceof Date
        ? new Date(endDate)
        : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        error: `Invalid recurrence endDate "${String(endDate)}" — a date the series stops after, or null for a series with no end`,
      };
    }
    ends = parsed;
  }

  return {
    ok: true,
    value: { frequency: frequency as RecurrenceFrequency, interval: every, endDate: ends, anchorDay: null },
  };
}

export function clampInterval(raw: string | number): number {
  const value = typeof raw === "number" ? raw : parseInt(raw, 10);
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_RECURRENCE_INTERVAL, Math.max(1, Math.trunc(value)));
}

export function nextRecurrenceDue(
  base: Date,
  frequency: RecurrenceFrequency,
  interval: number,
  anchorDay?: number | null
): Date {
  const next = new Date(base);

  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7 * interval);
      break;
    case "monthly": {
      const months = Number(interval);
      const day = anchorDay ?? base.getUTCDate();

      const endOfTargetMonth = new Date(base);
      endOfTargetMonth.setUTCFullYear(base.getUTCFullYear(), base.getUTCMonth() + months + 1, 0);

      next.setUTCFullYear(
        base.getUTCFullYear(),
        base.getUTCMonth() + months,
        Math.min(day, endOfTargetMonth.getUTCDate())
      );
      break;
    }
  }

  return next;
}

export interface RecurrenceLike {
  frequency: RecurrenceFrequency;
  interval: number;
  endDate?: Date | string | null;
  anchorDay?: number | null;
}

export function keptAnchor(
  stored: RecurrenceLike | null | undefined,
  incoming: NormalisedRecurrence | null
): number | null {
  if (!stored || !incoming) return null;
  if (stored.frequency !== incoming.frequency) return null;
  return stored.anchorDay ?? null;
}

export interface NextOccurrence {
  anchorDay: number | null;
  ended: boolean;
  dueDate: Date | null;
}

export function nextOccurrence(
  recurrence: RecurrenceLike,
  dueDate: Date | string | null | undefined,
  now = new Date()
): NextOccurrence {
  const anchorDay =
    recurrence.frequency === "monthly"
      ? (recurrence.anchorDay ?? (dueDate ? new Date(dueDate).getUTCDate() : null))
      : null;

  const next = dueDate
    ? nextRecurrenceDue(new Date(dueDate), recurrence.frequency, recurrence.interval, anchorDay)
    : null;
  const end = recurrence.endDate ? endOfDay(new Date(recurrence.endDate)) : null;
  return { ended: !!end && (next ?? now) > end, dueDate: next, anchorDay };
}

function endOfDay(day: Date): Date {
  const last = new Date(day);
  last.setUTCHours(23, 59, 59, 999);
  return last;
}

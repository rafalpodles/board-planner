import { RecurrenceFrequency } from "@/types";

// Both editors have advertised this bound as an HTML `max` since recurrence shipped, and nothing
// behind them held to it: a pasted 400 — or 100000 — was stored end to end.
export const MAX_RECURRENCE_INTERVAL = 365;

const FREQUENCIES: RecurrenceFrequency[] = ["daily", "weekly", "monthly"];

export interface NormalisedRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  /** null: the series has no end, which is now a decision the writer made rather than the only option */
  endDate: Date | null;
}

export type RecurrenceResult =
  | { ok: true; value: NormalisedRecurrence | null }
  | { ok: false; error: string };

/**
 * What a client may say about a repeating task. A field it gets wrong is refused rather than
 * dropped: `endDate` used to be neither stored nor rejected, so a client that set one got a 200
 * and a series that ran forever.
 */
export function normaliseRecurrence(raw: unknown): RecurrenceResult {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid recurrence — expected frequency and interval" };
  }

  const { frequency, interval, endDate } = raw as Record<string, unknown>;

  if (!FREQUENCIES.includes(frequency as RecurrenceFrequency)) {
    return {
      ok: false,
      error: `Invalid recurrence frequency "${String(frequency)}" — one of: ${FREQUENCIES.join(", ")}`,
    };
  }

  const every = typeof interval === "number" ? interval : Number(interval);
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

  return { ok: true, value: { frequency: frequency as RecurrenceFrequency, interval: every, endDate: ends } };
}

/** What an editor's number input may hand over. `max` alone stops neither typing nor pasting. */
export function clampInterval(raw: string | number): number {
  const value = typeof raw === "number" ? raw : parseInt(raw, 10);
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_RECURRENCE_INTERVAL, Math.max(1, Math.trunc(value)));
}

export function advance(from: Date, frequency: RecurrenceFrequency, interval: number): Date {
  const next = new Date(from);
  switch (frequency) {
    case "daily":
      next.setDate(next.getDate() + interval);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7 * interval);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + interval);
      break;
  }
  return next;
}

export interface RecurrenceLike {
  frequency: RecurrenceFrequency;
  interval: number;
  endDate?: Date | string | null;
}

export interface NextOccurrence {
  /** The series is over: nothing should be created */
  ended: boolean;
  /** null keeps an undated task undated — it used to come back dated `now + interval`, and every
   * occurrence after that re-anchored to its own close time, so a weekly series slid a few days
   * further out every time somebody closed it late */
  dueDate: Date | null;
}

export function nextOccurrence(
  recurrence: RecurrenceLike,
  dueDate: Date | string | null | undefined,
  now = new Date()
): NextOccurrence {
  const next = dueDate ? advance(new Date(dueDate), recurrence.frequency, recurrence.interval) : null;
  const end = recurrence.endDate ? new Date(recurrence.endDate) : null;
  // An undated series carries no clock of its own, so its end is judged against the day it reaches
  return { ended: !!end && (next ?? now) > end, dueDate: next };
}

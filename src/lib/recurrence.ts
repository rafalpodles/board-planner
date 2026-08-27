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
  // `raw === null` again, and not redundantly: `typeof null` is "object", so this test does not
  // exclude null on its own — it only looks like it does. The early return above happens to have
  // caught it, which makes the safety depend on line order rather than on this line.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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

export function nextRecurrenceDue(
  base: Date,
  frequency: RecurrenceFrequency,
  interval: number
): Date {
  // Every getter and setter below is a UTC one, and that is the whole point (BP-485). A due date
  // comes from `<input type="date">` as "2026-01-31", which Mongoose casts to UTC midnight. Read
  // back with local getters, the day being advanced was whatever day it happened to be where the
  // server runs: on a host west of UTC, 31 January read as the 30th and a monthly series landed in
  // March rather than on 28 February. UTC is the only reading of a date-with-no-time that does not
  // depend on that.
  //
  // The cost, deliberately accepted: UTC has no daylight saving, so a series carrying a real time
  // of day keeps its *UTC* time and its local wall clock moves by an hour across a transition. For
  // a date-only value — which is all the app can produce — midnight UTC stays midnight UTC.
  const next = new Date(base);

  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7 * interval);
      break;
    case "monthly": {
      // `setUTCMonth` does not clamp — 31 January + 1 month is 3 March, not 28 February (BP-461).
      // `setUTCFullYear` takes year, month and day together, so there is no intermediate date to
      // overflow. Day 0 of the month after the target is that target's last day.
      //
      // `interval` is coerced because `+` on a string concatenates: `0 + "2" + 1` is "021", and the
      // only caller reads it off a task typed `any`.
      const months = Number(interval);
      const day = base.getUTCDate();

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
  const next = dueDate
    ? nextRecurrenceDue(new Date(dueDate), recurrence.frequency, recurrence.interval)
    : null;
  const end = recurrence.endDate ? new Date(recurrence.endDate) : null;
  // An undated series carries no clock of its own, so its end is judged against the day it reaches
  return { ended: !!end && (next ?? now) > end, dueDate: next };
}

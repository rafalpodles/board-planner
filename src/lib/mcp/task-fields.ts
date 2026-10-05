import { z } from "zod";
import { RECURRENCE_FREQUENCIES } from "@/types";
import { MAX_RECURRENCE_INTERVAL } from "@/lib/recurrence";
import { echo } from "@/lib/echo";

export const DUE_DATE_PARAM = z
  .string()
  .optional()
  .describe("Due day, YYYY-MM-DD. Empty string clears it.");

export const SPRINT_PARAM = z
  .string()
  .optional()
  .describe(
    "The sprint this task belongs to, by name or id — one of this board's sprints, which list_sprints " +
      "shows. \"backlog\" or an empty string takes it out of its sprint."
  );

export const RECURRENCE_PARAM = z
  .object({
    frequency: z.enum(RECURRENCE_FREQUENCIES as [string, ...string[]]).describe("daily, weekly or monthly"),
    interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL).describe("Every this many days, weeks or months"),
    endDate: z.string().optional().describe("The day the series stops after, YYYY-MM-DD; leave out for no end"),
  })
  .nullable()
  .optional()
  .describe(
    "Makes the task repeat: when it is marked done the next one is created. null removes the repetition."
  );

/** A real calendar day: `Date` would take 2026-02-31 and move it into March. */
function isDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** null clears; a day passes; anything else is refused with the day it was asked in. */
export function dueDateValue(value: string): string | null {
  if (value === "") return null;
  if (!isDay(value)) throw new Error(`Invalid dueDate "${echo(value)}" — a day, YYYY-MM-DD`);
  return value;
}

export function recurrenceValue(
  value: { frequency: string; interval: number; endDate?: string } | null
): Record<string, unknown> | null {
  if (value === null) return null;
  const { frequency, interval, endDate } = value;
  if (endDate !== undefined && endDate !== "" && !isDay(endDate)) {
    throw new Error(`Invalid recurrence endDate "${echo(endDate)}" — a day, YYYY-MM-DD`);
  }
  return { frequency, interval, ...(endDate ? { endDate } : {}) };
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * The sprint to write: an id, or null for none. Always checked against this board's own sprints —
 * the create route drops a sprint of another board without a word, so an id passed through
 * unchecked would be answered 200 having put the task in no sprint at all.
 */
export function sprintForWrite(ref: string, sprints: { _id: string; name: string }[]): string | null {
  const wanted = ref.trim();
  if (wanted === "" || wanted.toLowerCase() === "backlog") return null;
  const byId = OBJECT_ID.test(wanted) ? sprints.find((s) => s._id === wanted) : undefined;
  const match = byId ?? sprints.find((s) => s.name.trim().toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const known = sprints.map((s) => s.name).join(", ") || "none";
    throw new Error(`No sprint named "${echo(wanted)}" on this board. Sprints: ${known}`);
  }
  return match._id;
}

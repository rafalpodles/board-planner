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
    endDate: z
      .string()
      .nullable()
      .optional()
      .describe("The day the series stops after, YYYY-MM-DD; leave out or null for no end"),
  })
  // Strict, like the tool around it: a stray `until` or `end_date` would otherwise be dropped and
  // the series would run forever under a 200
  .strict()
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
  value: { frequency: string; interval: number; endDate?: string | null } | null
): Record<string, unknown> | null {
  if (value === null) return null;
  const { frequency, interval, endDate } = value;
  if (endDate !== undefined && endDate !== null && endDate !== "" && !isDay(endDate)) {
    throw new Error(`Invalid recurrence endDate "${echo(endDate)}" — a day, YYYY-MM-DD`);
  }
  return { frequency, interval, ...(endDate ? { endDate } : {}) };
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export type SprintRow = { _id: string; name: string; status?: string };

/** How a sprint is pointed at when it has to be told apart from another of the same name: its id and its state. */
const withState = (s: SprintRow) => `${s._id} (${s.status ?? "unknown"})`;

/**
 * The one sprint a reference names, among this board's own. Names are not unique — a finished and a
 * planned sprint can both be "Sprint 4" — so a name two sprints share is refused with their ids
 * rather than answered for whichever came first.
 */
export function sprintMatching(ref: string, sprints: SprintRow[]): SprintRow {
  const wanted = ref.trim();
  const byId = OBJECT_ID.test(wanted)
    ? sprints.find((s) => String(s._id).toLowerCase() === wanted.toLowerCase())
    : undefined;
  if (byId) return byId;
  const named = sprints.filter((s) => s.name.trim().toLowerCase() === wanted.toLowerCase());
  if (named.length > 1) {
    throw new Error(`${named.length} sprints are named "${echo(wanted)}" — pass the id of one: ${named.map(withState).join(", ")}`);
  }
  if (!named[0]) {
    const known = sprints.map((s) => s.name).join(", ") || "none";
    throw new Error(`No sprint "${echo(wanted)}" on this board, by name or id. Sprints: ${known}`);
  }
  return named[0];
}

/**
 * The sprint to write: an id, or null for none. Always checked against this board's own sprints —
 * the create route drops a sprint of another board without a word, so an id passed through
 * unchecked would be answered 200 having put the task in no sprint at all. A completed sprint is
 * refused too: the screens never offer one, and a task added to it moves its counts and its
 * velocity after the fact.
 */
export function sprintForWrite(ref: string, sprints: SprintRow[]): string | null {
  if (sprintClears(ref)) return null;
  const sprint = sprintMatching(ref, sprints);
  if (sprint.status === "completed") {
    throw new Error(`Sprint "${echo(sprint.name)}" is completed — a task cannot be added to it. Sprints are listed by list_sprints.`);
  }
  return sprint._id;
}

/** "backlog" and an empty string take a task out of its sprint, with no lookup to make. */
export const sprintClears = (ref: string) => ref.trim() === "" || ref.trim().toLowerCase() === "backlog";

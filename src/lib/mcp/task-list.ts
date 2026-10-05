import { taskKeyOf } from "@/lib/task-key";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

type Row = {
  taskNumber: number;
  title?: string;
  status?: string;
  priority?: string;
  assignee?: { username?: string } | null;
  dueDate?: string | null;
  sprint?: { name?: string } | null;
  parent?: { taskNumber?: number } | null;
};

/** One line of a listing: what is needed to pick work from it, and a key to act on it with. */
export function listedTask(row: Row, projectKey: string) {
  return {
    key: taskKeyOf(projectKey, row.taskNumber),
    title: row.title,
    status: row.status,
    priority: row.priority ?? "medium",
    assignee: row.assignee?.username ?? null,
    dueDate: row.dueDate ? String(row.dueDate).slice(0, 10) : null,
    sprint: row.sprint?.name ?? null,
    parent: typeof row.parent?.taskNumber === "number" ? taskKeyOf(projectKey, row.parent.taskNumber) : null,
  };
}

/**
 * A page that says how much of the whole it is. A truncated list reads as a complete one, so
 * `nextOffset` is null only when nothing follows.
 */
export function pageOf<T>(tasks: T[], total: number, offset: number) {
  const end = offset + tasks.length;
  return { total, returned: tasks.length, offset, nextOffset: end < total ? end : null, tasks };
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** An id and the backlog sentinel go to the route as they are; only a name needs the board's sprints. */
export const sprintNeedsLookup = (ref: string) =>
  !OBJECT_ID.test(ref.trim()) && ref.trim().toLowerCase() !== "backlog";

/**
 * What the tasks route's `sprint` filter takes: an id, or "backlog". A name is looked up — and
 * names are not unique (a finished and a planned sprint can both be "Sprint 4"), so a name that two
 * sprints share is refused with their ids rather than answered for whichever came first.
 */
export function sprintParam(ref: string, sprints: { _id: string; name: string }[]): string {
  const wanted = ref.trim();
  if (wanted.toLowerCase() === "backlog") return "backlog";
  if (OBJECT_ID.test(wanted)) return wanted;
  const matches = sprints.filter((s) => s.name.trim().toLowerCase() === wanted.toLowerCase());
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} sprints are named "${wanted.slice(0, 64)}" — pass the id of one: ${matches.map((s) => s._id).join(", ")}`
    );
  }
  if (!matches[0]) {
    const known = sprints.map((s) => s.name).join(", ") || "none";
    throw new Error(`No sprint named "${wanted.slice(0, 64)}" on this board. Sprints: ${known}, or "backlog" for tasks in none`);
  }
  return matches[0]._id;
}

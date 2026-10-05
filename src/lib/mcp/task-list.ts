import { taskKeyOf } from "@/lib/task-key";
import { progressLine } from "@/lib/epic-progress";
import { findSprint, type SprintRow } from "./sprints";

export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, pageOf } from "./paging";


type Row = {
  taskNumber: number;
  title?: string;
  status?: string;
  priority?: string;
  assignee?: { username?: string } | null;
  dueDate?: string | null;
  sprint?: { name?: string } | null;
  parent?: { taskNumber?: number } | null;
  progress?: { done: number; total: number };
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
    ...(row.progress ? { progress: progressLine(row.progress) } : {}),
  };
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** An id and the backlog sentinel go to the route as they are; only a name needs the board's sprints. */
export const sprintNeedsLookup = (ref: string) =>
  !OBJECT_ID.test(ref.trim()) && ref.trim().toLowerCase() !== "backlog";

/** What the tasks route's `sprint` filter takes: an id, or "backlog" — a name is looked up among the board's own. */
export function sprintParam(ref: string, sprints: SprintRow[]): string {
  const wanted = ref.trim();
  if (wanted.toLowerCase() === "backlog") return "backlog";
  if (OBJECT_ID.test(wanted)) return wanted;
  return findSprint(wanted, sprints)._id;
}

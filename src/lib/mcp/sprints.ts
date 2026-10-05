import { echo } from "@/lib/echo";

export type SprintRow = {
  _id: string;
  name: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
  taskCount?: number;
  doneCount?: number;
};

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * The one sprint of this board a reference names: its id, or its name in any case. Names are not
 * unique — a finished and a planned sprint can both be "Sprint 4" — so a name two sprints share is
 * refused with their ids, never answered for whichever came first. A write that acts on a sprint
 * (delete, complete) is exactly where the wrong one is expensive.
 */
export function findSprint(ref: string, sprints: SprintRow[]): SprintRow {
  const wanted = ref.trim();
  const byId = OBJECT_ID.test(wanted)
    ? sprints.find((s) => String(s._id).toLowerCase() === wanted.toLowerCase())
    : undefined;
  if (byId) return byId;
  const named = sprints.filter((s) => s.name.trim().toLowerCase() === wanted.toLowerCase());
  if (named.length > 1) {
    throw new Error(
      `${named.length} sprints are named "${echo(wanted)}" — pass the id of one: ${named.map((s) => `${s._id} (${s.status ?? "unknown"})`).join(", ")}`
    );
  }
  if (!named[0]) {
    throw new Error(`No sprint "${echo(wanted)}" on this board, by name or id. Sprints: ${sprints.map((s) => s.name).join(", ") || "none"}`);
  }
  return named[0];
}

const day = (value?: string) => (value ? String(value).slice(0, 10) : null);

export const sprintSummary = (sprint: SprintRow) => ({
  id: String(sprint._id),
  name: sprint.name,
  status: sprint.status,
  startDate: day(sprint.startDate),
  endDate: day(sprint.endDate),
  goal: sprint.goal ?? "",
  taskCount: sprint.taskCount ?? 0,
  doneCount: sprint.doneCount ?? 0,
});

/**
 * Where a completing sprint's unfinished tasks go: the backlog, or another sprint of the board that
 * is still open to them. Refused before anything is written, because the route runs the move ahead
 * of the status change.
 */
export function incompleteDestination(
  ref: string,
  sprints: SprintRow[],
  completing: SprintRow
): { moveIncompleteToBacklog: true } | { moveIncompleteToSprint: string } {
  if (ref.trim().toLowerCase() === "backlog") return { moveIncompleteToBacklog: true };
  const destination = findSprint(ref, sprints);
  if (destination._id === completing._id) {
    throw new Error(`"${echo(completing.name)}" cannot be its own destination — unfinished tasks have to go somewhere else`);
  }
  if (destination.status === "completed") {
    throw new Error(`Sprint "${echo(destination.name)}" is completed — unfinished tasks cannot be moved into it`);
  }
  return { moveIncompleteToSprint: destination._id };
}

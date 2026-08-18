import { ApiTask, ApiUserSummary, ColumnRole } from "@/types";
import { AnyColumn, columnFor } from "@/lib/columns";

/**
 * Which of the claim's requirements this task fails, of the ones a browser can see. The claim
 * answers silently — it takes the task or it does not — so without this the product has nothing to
 * say to somebody who chose an agent and watched nothing happen.
 *
 * Deliberately not a promise that a machine WILL take it. `claimNextTask`'s filter also weighs
 * open blockers, spent attempts, whether the project is enabled for workers, and whether the
 * assignee owns a live machine at all — none of which is on the task in front of the reader. So
 * `runs: true` means "nothing about this task's own hand-over is stopping it", and every `false`
 * is a definite no. Kept in step by hand: the filter runs inside MongoDB against every task at
 * once, and there is no shared expression the two could be written from.
 */
export type HandoverReason =
  | "no-agent"
  | "not-approved-yet"
  | "unassigned"
  | "assigner-unrecorded"
  | "assigned-by-someone-else";

export type Handover =
  | { runs: true }
  | { runs: false; reason: HandoverReason; by: string | null };

type Judged = Pick<ApiTask, "agent" | "assignee" | "assignedBy" | "status">;

function idOf(ref: ApiTask["assignedBy"]): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : String(ref._id);
}

function nameOf(ref: ApiTask["assignedBy"]): string | null {
  if (!ref || typeof ref === "string") return null;
  const user = ref as ApiUserSummary;
  return user.fullName || user.username || null;
}

// Where work is still waiting for the column a claim looks at. Past the approved one the machine
// has already had its chance — a run may be holding the task at this moment — and "nothing will run
// this yet" printed beside the live run indicator is a plain contradiction; on a finished task it
// is nonsense. `blocked` belongs here rather than after: a parked task has not been taken, and
// moving it back to the approved column is exactly what would run it.
const AWAITING_APPROVAL: ColumnRole[] = ["backlog", "blocked"];

function stillWaitingForApproval(columns: AnyColumn[], status: string): boolean {
  const role = columnFor({ columns }, status)?.role;
  // A status naming no column at all is what a task left behind by a deleted column carries, and
  // that is nowhere a claim looks either.
  return role === undefined || AWAITING_APPROVAL.includes(role);
}

/**
 * @param columns the board's own columns, which carry the roles a claim is defined in terms of.
 * Omitted where the caller does not know them, and then this requirement is not judged.
 */
export function handoverOf(task: Judged, columns?: AnyColumn[]): Handover {
  if (!task.agent) return { runs: false, reason: "no-agent", by: null };
  // The everyday false positive without it: pick an agent on a task still in the backlog, assign it
  // to yourself, and every other requirement passes while no claim ever looks at that column.
  if (columns && stillWaitingForApproval(columns, task.status)) {
    return { runs: false, reason: "not-approved-yet", by: null };
  }
  // Populate renders a reference to a deleted user as null, and typeof null is "object" — so this
  // has to test the value, not its type, or a deleted assigner reads as a live one.
  if (!task.assignee) return { runs: false, reason: "unassigned", by: null };

  const assigner = idOf(task.assignedBy);
  // Absent on every task assigned before BP-358, and deliberately never backfilled: the document
  // does not record whether that person handed it to themselves, and guessing would invent consent.
  if (!assigner) return { runs: false, reason: "assigner-unrecorded", by: null };

  if (assigner !== String(task.assignee._id)) {
    return { runs: false, reason: "assigned-by-someone-else", by: nameOf(task.assignedBy) };
  }
  return { runs: true };
}

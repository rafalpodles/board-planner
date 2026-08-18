import { ApiTask, ApiUserSummary } from "@/types";

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

/**
 * @param approvedStatuses the board's `approved`-role columns, which is the only place a claim
 * looks. Omitted where the caller does not know them, and then this requirement is not judged.
 */
export function handoverOf(task: Judged, approvedStatuses?: string[]): Handover {
  if (!task.agent) return { runs: false, reason: "no-agent", by: null };
  // The everyday false positive without it: pick an agent on a task still in the backlog, assign it
  // to yourself, and every other requirement passes while no claim ever looks at that column.
  if (approvedStatuses && !approvedStatuses.includes(task.status)) {
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

import { ApiTask, ApiUserSummary } from "@/types";

/**
 * Whether a machine will ever pick this task up, and if not, which of the claim's requirements it
 * fails. The claim answers this silently — it takes the task or it does not — so without this the
 * product has nothing to say to somebody who chose an agent and watched nothing happen.
 *
 * Kept in step with `claimNextTask`'s filter by hand: the filter runs inside MongoDB against every
 * task at once, and there is no shared expression the two could both be written from.
 */
export type HandoverReason =
  | "no-agent"
  | "unassigned"
  | "assigner-unrecorded"
  | "assigned-by-someone-else";

export type Handover =
  | { runs: true }
  | { runs: false; reason: HandoverReason; by: string | null };

type Judged = Pick<ApiTask, "agent" | "assignee" | "assignedBy">;

function idOf(ref: ApiTask["assignedBy"]): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : String(ref._id);
}

function nameOf(ref: ApiTask["assignedBy"]): string | null {
  if (!ref || typeof ref === "string") return null;
  const user = ref as ApiUserSummary;
  return user.fullName || user.username || null;
}

export function handoverOf(task: Judged): Handover {
  if (!task.agent) return { runs: false, reason: "no-agent", by: null };
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

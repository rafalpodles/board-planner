import { ApiTask, ApiUserSummary, ColumnRole } from "@/types";
import { AnyColumn, columnFor } from "@/lib/columns";
import { PM_USERNAME } from "@/lib/pm/username";

export type HandoverReason =
  | "no-agent"
  | "not-approved-yet"
  | "unassigned"
  | "assigner-unrecorded"
  | "assigned-by-someone-else"
  | "pm-assigned-for-someone-else";

export type Handover =
  | { runs: true }
  | { runs: false; reason: HandoverReason; by: string | null };

type Judged = Pick<ApiTask, "agent" | "assignee" | "assignedBy" | "pmAssignedFor" | "status">;

export function refIdOf(
  ref: { _id: string } | string | null | undefined
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : String(ref._id);
}

function assignedByPm(ref: ApiTask["assignedBy"]): boolean {
  if (!ref || typeof ref === "string") return false;
  return (ref as ApiUserSummary).username === PM_USERNAME;
}

function nameOf(ref: ApiTask["assignedBy"]): string | null {
  if (!ref || typeof ref === "string") return null;
  const user = ref as ApiUserSummary;
  return user.fullName || user.username || null;
}

const AWAITING_APPROVAL: ColumnRole[] = ["backlog", "blocked"];

function stillWaitingForApproval(columns: AnyColumn[], status: string): boolean {
  const role = columnFor({ columns }, status)?.role;
  return role === undefined || AWAITING_APPROVAL.includes(role);
}

export function handoverOf(task: Judged, columns?: AnyColumn[]): Handover {
  if (!task.agent) return { runs: false, reason: "no-agent", by: null };
  if (columns && stillWaitingForApproval(columns, task.status)) {
    return { runs: false, reason: "not-approved-yet", by: null };
  }
  if (!task.assignee) return { runs: false, reason: "unassigned", by: null };

  const assigner = refIdOf(task.assignedBy);
  if (!assigner) return { runs: false, reason: "assigner-unrecorded", by: null };

  if (assignedByPm(task.assignedBy)) {
    return refIdOf(task.pmAssignedFor) === String(task.assignee._id)
      ? { runs: true }
      : { runs: false, reason: "pm-assigned-for-someone-else", by: nameOf(task.assignedBy) };
  }
  if (assigner !== String(task.assignee._id)) {
    return { runs: false, reason: "assigned-by-someone-else", by: nameOf(task.assignedBy) };
  }
  return { runs: true };
}

import { Types } from "mongoose";
import { InstanceAuditLog } from "@/models/instanceAuditLog";
import { InstanceAuditAction } from "@/types";

interface InstanceAuditEntry {
  action: InstanceAuditAction;
  // What was acted on, as a person would name it — a machine's name, a project's key. Read at the
  // call site while the subject is still in hand, because the log has to survive its deletion.
  target?: string;
  // Null when a machine did it, which registration is: the caller holds an enrolment token and no
  // session. The reader shows "system", the same word the project log already uses.
  user?: Types.ObjectId | string | null;
  // Read at the call site while the actor is in hand, because the reference above stops naming
  // anybody the moment that account is deleted — and an administrator being removed is exactly
  // when the rows they wrote start to matter
  actorUsername?: string;
  detail?: string;
}

// Fire and forget, like logProjectAudit: an audit write that could fail the action it records would
// be worse than the gap it closes.
export async function logInstanceAudit(entry: InstanceAuditEntry): Promise<void> {
  try {
    await InstanceAuditLog.create({
      user: entry.user ?? null,
      actorUsername: entry.actorUsername || "",
      action: entry.action,
      target: entry.target || "",
      detail: entry.detail || "",
    });
  } catch {
    console.warn("Failed to log instance audit");
  }
}

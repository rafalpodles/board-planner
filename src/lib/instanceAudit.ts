import { Types } from "mongoose";
import { InstanceAuditLog } from "@/models/instanceAuditLog";
import { InstanceAuditAction } from "@/types";

interface InstanceAuditEntry {
  action: InstanceAuditAction;
  target?: string;
  user?: Types.ObjectId | string | null;
  actorUsername?: string;
  detail?: string;
}

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

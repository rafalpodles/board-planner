import { Types } from "mongoose";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { ProjectAuditAction } from "@/types";

export async function logProjectAudit(
  projectId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  action: ProjectAuditAction,
  detail?: string
): Promise<void> {
  try {
    await ProjectAuditLog.create({
      project: projectId,
      user: userId,
      action,
      detail: detail || "",
    });
  } catch {
    console.warn("Failed to log project audit");
  }
}

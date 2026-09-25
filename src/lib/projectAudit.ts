import { Types } from "mongoose";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { ProjectAuditAction } from "@/types";

// The view renders a detail's line breaks, so only lines passed as lines may carry one: a name
// somebody typed with a newline in it would otherwise print as a settings line of its own
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}

export async function logProjectAudit(
  projectId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  action: ProjectAuditAction,
  detail?: string | string[]
): Promise<void> {
  const lines = (Array.isArray(detail) ? detail : [detail ?? ""]).map(oneLine).filter(Boolean);
  try {
    await ProjectAuditLog.create({
      project: projectId,
      user: userId,
      action,
      detail: lines.join("\n"),
    });
  } catch {
    console.warn("Failed to log project audit");
  }
}

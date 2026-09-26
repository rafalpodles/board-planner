import { Types } from "mongoose";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { ProjectAuditAction } from "@/types";
import { isControlCodePoint } from "@/lib/identifiers";

// A name somebody typed is one line of text, whatever it carries: a newline would print as a
// settings line of its own, and a bidi override reorders the rest of the row
function oneLine(text: string): string {
  return Array.from(text.replace(/\s+/g, " "), (ch) =>
    isControlCodePoint(ch.codePointAt(0) ?? 0) ? "" : ch
  )
    .join("")
    .trim();
}

// Only the lines passed as lines are stored as lines; the view renders nothing else on more than one
export async function logProjectAudit(
  projectId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  action: ProjectAuditAction,
  detail?: string | string[]
): Promise<void> {
  try {
    const lines = (Array.isArray(detail) ? detail : [detail ?? ""]).map(oneLine).filter(Boolean);
    await ProjectAuditLog.create({
      project: projectId,
      user: userId,
      action,
      detail: lines.join("\n"),
      ...(Array.isArray(detail) ? { lines } : {}),
    });
  } catch {
    console.warn("Failed to log project audit");
  }
}

import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { auditExport, machineRefusal } from "@/lib/audit-routes";

export const GET = withProjectOwner(async (request, { params, user, db }) => {
  const refused = machineRefusal(user);
  if (refused) return refused;

  const { projectId } = await params;
  await connectDB();
  const project = await db.Project.findById(projectId).select("key").lean<{ key?: string }>();
  return auditExport(db, request, { projectId, name: `${(project?.key ?? "project").toLowerCase()}-audit-log` });
});

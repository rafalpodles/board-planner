import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { auditList } from "@/lib/audit-routes";

export const GET = withProjectOwner(async (request, { params, db }) => {
  const { projectId } = await params;
  await connectDB();
  return auditList(db, request, { projectId });
});

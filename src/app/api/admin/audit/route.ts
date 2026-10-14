import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { auditList, machineRefusal } from "@/lib/audit-routes";

// Instance admin only, mirroring who can perform the actions it records. A project admin can read
// their own project's audit log; nothing here belongs to a project.
export const GET = withAdmin(async (request, { user, db }) => {
  // Parity with the enrolment reads, not with /api/admin/workers. An unscoped admin API token
  // keeps role "admin", and one of those sitting on a worker's disk is readable by the agent
  // running there — which would hand it the whole fleet history rather than one project's.
  const refused = machineRefusal(user);
  if (refused) return refused;

  await connectDB();
  return auditList(db, request, {});
});

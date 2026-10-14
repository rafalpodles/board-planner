import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { auditExport, machineRefusal } from "@/lib/audit-routes";

export const GET = withAdmin(async (request, { user, db }) => {
  const refused = machineRefusal(user);
  if (refused) return refused;

  await connectDB();
  return auditExport(db, request, { name: "audit-log" });
});

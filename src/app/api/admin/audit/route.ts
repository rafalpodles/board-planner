import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { InstanceAuditLog } from "@/models/instanceAuditLog";

// Instance admin only, mirroring who can perform the actions it records. A project admin can read
// their own project's audit log; nothing here belongs to a project.
export const GET = withAdmin(async (_request, { user }) => {
  // Parity with the enrolment reads, not with /api/admin/workers. An unscoped admin API token
  // keeps role "admin", and one of those sitting on a worker's disk is readable by the agent
  // running there — which would hand it the whole fleet history rather than one project's.
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  await connectDB();

  const logs = await InstanceAuditLog.find()
    .populate("user", "username fullName")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return NextResponse.json(logs);
});

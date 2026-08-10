import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { InstanceAuditLog } from "@/models/instanceAuditLog";

// Instance admin only, mirroring who can perform the actions it records. A project admin can read
// their own project's audit log; nothing here belongs to a project.
export const GET = withAdmin(async () => {
  await connectDB();

  const logs = await InstanceAuditLog.find()
    .populate("user", "username fullName")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return NextResponse.json(logs);
});

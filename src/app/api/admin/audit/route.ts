import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { InstanceAuditLog } from "@/models/instanceAuditLog";

export const GET = withAdmin(async (_request, { user }) => {
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

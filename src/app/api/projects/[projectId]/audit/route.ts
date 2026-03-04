import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { ProjectAuditLog } from "@/models/projectAuditLog";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const logs = await ProjectAuditLog.find({ project: projectId })
    .populate("user", "username fullName")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return NextResponse.json(logs);
});

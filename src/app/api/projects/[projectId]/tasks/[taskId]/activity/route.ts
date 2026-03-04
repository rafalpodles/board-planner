import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { ActivityLog } from "@/models/activityLog";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { taskId } = await params;
  await connectDB();

  const logs = await ActivityLog.find({ task: taskId })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("user", "username fullName")
    .lean();

  return NextResponse.json(logs);
});

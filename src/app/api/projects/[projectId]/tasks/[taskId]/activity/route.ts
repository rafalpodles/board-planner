import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { ActivityLog } from "@/models/activityLog";
import { Task } from "@/models/task";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to this project
  const taskExists = await Task.exists({ _id: taskId, project: projectId });
  if (!taskExists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const logs = await ActivityLog.find({ task: taskId })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("user", "username fullName")
    .lean();

  return NextResponse.json(logs);
});

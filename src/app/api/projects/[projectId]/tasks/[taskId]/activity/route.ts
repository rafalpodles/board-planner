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
    // One act can write several rows in the same millisecond — a re-parented task loses and gains
    // a parent in one request — and `createdAt` alone then orders them arbitrarily, which reads as
    // the task gaining a parent before losing it. `_id` rises with insertion, so it breaks the tie
    // the way the eye expects (BP-658).
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .populate("user", "username fullName")
    .lean();

  return NextResponse.json(logs);
});

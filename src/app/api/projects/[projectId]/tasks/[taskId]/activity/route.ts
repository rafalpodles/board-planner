import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { ActivityLog } from "@/models/activityLog";
import { Task } from "@/models/task";
import { editSessions, presentSessions, type ActivityHeader } from "@/lib/activity";
import type { IActivityLog } from "@/types";

const SHOWN = 100;
const SCANNED = 1000;

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to this project
  const taskExists = await Task.exists({ _id: taskId, project: projectId });
  if (!taskExists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // `_id` breaks a `createdAt` tie: one request can write several rows in a millisecond (BP-658)
  const headers = await ActivityLog.find({ task: taskId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(SCANNED)
    .select("user action field customField createdAt")
    .lean<ActivityHeader[]>();

  const sessions = editSessions(headers).slice(0, SHOWN);
  const ids = new Set(sessions.flatMap((s) => [String(s.newest._id), String(s.oldest._id)]));
  const rows = await ActivityLog.find({ _id: { $in: [...ids] } })
    .populate("user", "username fullName")
    .lean<IActivityLog[]>();
  const logs = presentSessions(sessions, rows);

  return NextResponse.json(logs);
});

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
    // a parent in one request — and `createdAt` alone leaves that pair in an arbitrary order, so
    // half the time the list claims the task lost its parent AFTER it gained one. `_id` rises with
    // insertion, and this list is newest-first, so `-1` puts the row written last at the top,
    // which is where it belongs (BP-658).
    //
    // The index is `{ task: 1, createdAt: -1 }`, so the tie-break makes this a blocking sort
    // rather than a scan in index order. With `limit(100)` over one task's own history that is a
    // top-k on a small set; it was measured against widening the index and judged not worth a
    // second index build on a live collection.
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .populate("user", "username fullName")
    .lean();

  return NextResponse.json(logs);
});

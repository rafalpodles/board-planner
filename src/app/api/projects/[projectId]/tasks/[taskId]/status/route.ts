import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { TASK_STATUSES, TaskStatus } from "@/types";
import { logActivity } from "@/lib/activity";

export const PATCH = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { status } = await request.json();

  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${TASK_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const oldTask = await Task.findOne({ _id: taskId, project: projectId }).lean();
  if (!oldTask) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $set: { status } },
    { new: true }
  ).populate([
    { path: "assignee", select: "username fullName" },
    { path: "createdBy", select: "username fullName" },
  ]);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (oldTask.status !== status) {
    await logActivity(taskId, user._id, "status_changed", "status", oldTask.status, status);
  }

  return NextResponse.json(task);
});

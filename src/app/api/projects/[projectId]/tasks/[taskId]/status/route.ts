import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Task } from "@/models/task";
import { TASK_STATUSES, TaskStatus } from "@/types";

export const PATCH = withAuth(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { status } = await request.json();

  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${TASK_STATUSES.join(", ")}` },
      { status: 400 }
    );
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

  return NextResponse.json(task);
});

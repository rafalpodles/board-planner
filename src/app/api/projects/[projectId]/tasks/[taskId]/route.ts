import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { ActivityLog } from "@/models/activityLog";
import { Notification } from "@/models/notification";
import { updateTask } from "@/lib/task-service";

const populateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
];

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId })
    .populate(populateFields);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Find tasks that this task is blocking (reverse lookup)
  const blocking = await Task.find(
    { blockedBy: taskId, project: projectId },
    "taskNumber title status"
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskObj: any = task.toObject();
  taskObj.blocking = blocking;

  return NextResponse.json(taskObj);
});

export const PUT = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  await connectDB();

  const body = await request.json();

  const result = await updateTask(projectId, taskId, body, String(user._id));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.data);
});

export const DELETE = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  await connectDB();

  const task = await Task.findOneAndDelete({
    _id: taskId,
    project: projectId,
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  await Promise.all([
    Comment.deleteMany({ task: taskId }),
    ActivityLog.deleteMany({ task: taskId }),
    Notification.deleteMany({ task: taskId }),
    Task.updateMany({ blockedBy: taskId }, { $pull: { blockedBy: taskId } }),
  ]);

  return NextResponse.json({ message: "Task deleted" });
});

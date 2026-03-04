import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { User } from "@/models/user";

const populateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
];

export const GET = withAuth(async (_request, { params }) => {
  const { projectId, taskId } = await params;
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

export const PUT = withAuth(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json();

  // Whitelist allowed fields to prevent overwriting protected fields
  const allowed = [
    "title", "description", "difficulty", "component", "category",
    "status", "assignee", "acceptanceCriteria", "order",
  ];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  // Resolve assignee username to ObjectId if provided as string
  if (updates.assignee && typeof updates.assignee === "string") {
    const assigneeUser = await User.findOne({
      username: (updates.assignee as string).toLowerCase(),
    });
    updates.assignee = assigneeUser ? assigneeUser._id : null;
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $set: updates },
    { new: true, runValidators: true }
  ).populate(populateFields);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task);
});

export const DELETE = withAuth(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await Task.findOneAndDelete({
    _id: taskId,
    project: projectId,
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Delete associated comments
  await Comment.deleteMany({ task: taskId });

  return NextResponse.json({ message: "Task deleted" });
});

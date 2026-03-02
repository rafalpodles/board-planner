import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { User } from "@/models/user";

const populateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
];

export const GET = withAuth(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId })
    .populate(populateFields);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task);
});

export const PUT = withAuth(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json();

  // Resolve assignee username to ObjectId if provided as string
  if (body.assignee && typeof body.assignee === "string") {
    const assigneeUser = await User.findOne({
      username: body.assignee.toLowerCase(),
    });
    body.assignee = assigneeUser ? assigneeUser._id : null;
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $set: body },
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

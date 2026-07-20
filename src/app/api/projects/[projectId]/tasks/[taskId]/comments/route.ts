import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Comment } from "@/models/comment";
import { Task } from "@/models/task";
import { addComment } from "@/lib/task-service";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to project
  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const comments = await Comment.find({ task: taskId })
    .sort({ createdAt: 1 })
    .populate("author", "username fullName")
    .populate("reactions.user", "username fullName");

  return NextResponse.json(comments);
});

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { body } = await request.json();

  const result = await addComment(projectId, taskId, body, {
    id: String(user._id),
    username: user.username,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.data, { status: 201 });
});

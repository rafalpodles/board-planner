import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectAccessOrWorker } from "@/lib/middleware";
import { addComment } from "@/lib/task-service";

export const GET = withProjectAccess(async (_request, { params, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to project
  const task = await db.Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const comments = await db.Comment.find({ task: taskId })
    .sort({ createdAt: 1 })
    .populate("author", "username fullName")
    .populate("reactions.user", "username fullName");

  return NextResponse.json(comments);
});

export const POST = withProjectAccessOrWorker(async (request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { body } = await request.json();

  const result = await addComment(db, projectId, taskId, body, {
    id: String(user._id),
    username: user.username,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.data, { status: 201 });
});

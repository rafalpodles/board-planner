import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Comment } from "@/models/comment";
import { Task } from "@/models/task";

export const GET = withAuth(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to project
  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const comments = await Comment.find({ task: taskId })
    .sort({ createdAt: 1 })
    .populate({ path: "author", select: "username fullName" });

  return NextResponse.json(comments);
});

export const POST = withAuth(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to project
  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const { body } = await request.json();

  if (!body || typeof body !== "string" || !body.trim()) {
    return NextResponse.json(
      { error: "Comment body is required" },
      { status: 400 }
    );
  }

  const comment = await Comment.create({
    task: taskId,
    author: user._id,
    body: body.trim(),
  });

  const populated = await Comment.findById(comment._id).populate({
    path: "author",
    select: "username fullName",
  });

  return NextResponse.json(populated, { status: 201 });
});

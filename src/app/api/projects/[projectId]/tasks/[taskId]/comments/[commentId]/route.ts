import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Comment } from "@/models/comment";
import { Task } from "@/models/task";

export const PUT = withAuth(async (request, { params, user }) => {
  const { projectId, taskId, commentId } = await params;
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const comment = await Comment.findOne({ _id: commentId, task: taskId });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  if (comment.author.toString() !== user._id.toString()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { body } = await request.json();
  if (!body || typeof body !== "string" || !body.trim()) {
    return NextResponse.json(
      { error: "Comment body is required" },
      { status: 400 }
    );
  }

  comment.body = body.trim();
  await comment.save();

  const populated = await Comment.findById(comment._id).populate({
    path: "author",
    select: "username fullName",
  });

  return NextResponse.json(populated);
});

export const DELETE = withAuth(async (_request, { params, user }) => {
  const { projectId, taskId, commentId } = await params;
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const comment = await Comment.findOne({ _id: commentId, task: taskId });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  if (comment.author.toString() !== user._id.toString()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await comment.deleteOne();

  return NextResponse.json({ message: "Comment deleted" });
});

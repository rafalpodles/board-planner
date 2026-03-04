import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";

export const GET = withProjectAccess(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId).populate(
    "owner",
    "username fullName"
  );

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
});

export const PUT = withProjectAccess(async (request, { params }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  const allowed = ["name", "description", "key", "githubRepo"];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  const project = await Project.findByIdAndUpdate(projectId, updates, {
    new: true,
  }).populate("owner", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
});

export const DELETE = withProjectAccess(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Delete all comments on tasks in this project
  const taskIds = await Task.find({ project: projectId }).distinct("_id");
  await Comment.deleteMany({ task: { $in: taskIds } });

  // Delete all tasks in this project
  await Task.deleteMany({ project: projectId });

  // Delete the project itself
  await Project.findByIdAndDelete(projectId);

  return NextResponse.json({ message: "Project deleted" });
});

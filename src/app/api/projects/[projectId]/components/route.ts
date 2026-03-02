import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Project } from "@/models/project";

export const GET = withAuth(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId).select("components");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.components);
});

export const POST = withAuth(async (request, { params }) => {
  await connectDB();
  const { projectId } = await params;
  const { name } = await request.json();

  if (!name) {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 }
    );
  }

  const project = await Project.findByIdAndUpdate(
    projectId,
    { $addToSet: { components: name } },
    { new: true }
  ).select("components");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.components);
});

export const DELETE = withAuth(async (request, { params }) => {
  await connectDB();
  const { projectId } = await params;
  const { name } = await request.json();

  if (!name) {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 }
    );
  }

  const project = await Project.findByIdAndUpdate(
    projectId,
    { $pull: { components: name } },
    { new: true }
  ).select("components");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.components);
});

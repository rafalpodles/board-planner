import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";

export const GET = withProjectAccess(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId).select("components");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.components);
});

export const POST = withProjectAccess(async (request, { params, user }) => {
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

  logProjectAudit(projectId, user._id, "component_added", name);

  return NextResponse.json(project.components);
});

export const DELETE = withProjectAccess(async (request, { params, user }) => {
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

  logProjectAudit(projectId, user._id, "component_removed", name);

  return NextResponse.json(project.components);
});

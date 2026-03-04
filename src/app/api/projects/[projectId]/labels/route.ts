import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.labels || []);
});

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { name, color } = await request.json();
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Label name is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const labels = project.labels || [];
  if (labels.some((l) => l.name.toLowerCase() === name.trim().toLowerCase())) {
    return NextResponse.json({ error: "Label already exists" }, { status: 409 });
  }

  labels.push({ name: name.trim(), color: color || "#3b82f6" } as typeof labels[number]);
  project.labels = labels;
  await project.save();

  logProjectAudit(projectId, user._id, "label_added", name.trim());

  return NextResponse.json(project.labels, { status: 201 });
});

export const DELETE = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { labelId } = await request.json();
  if (!labelId) {
    return NextResponse.json({ error: "labelId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const removed = (project.labels || []).find((l) => l._id.toString() === labelId);
  project.labels = (project.labels || []).filter(
    (l) => l._id.toString() !== labelId
  );
  await project.save();

  if (removed) logProjectAudit(projectId, user._id, "label_removed", removed.name);

  return NextResponse.json(project.labels);
});

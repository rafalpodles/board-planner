import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { logProjectAudit } from "@/lib/projectAudit";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "categories");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.categories || []);
});

export const POST = withProjectAdmin(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { name, color } = await request.json();
  if (!name || typeof name !== "string" || !name.trim() || name.trim().length > 50) {
    return NextResponse.json(
      { error: "Category name is required (max 50 chars)" },
      { status: 400 }
    );
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const categories = project.categories || [];
  if (categories.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())) {
    return NextResponse.json({ error: "Category already exists" }, { status: 409 });
  }

  categories.push({ name: name.trim(), color: color || "#3b82f6" } as typeof categories[number]);
  project.categories = categories;
  await project.save();

  logProjectAudit(projectId, user._id, "settings_updated", `Category added: ${name.trim()}`);

  return NextResponse.json(project.categories, { status: 201 });
});

export const DELETE = withProjectAdmin(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { name } = await request.json();
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const categories = project.categories || [];
  const removed = categories.find((c) => c.name === name);
  if (!removed) {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }
  if (categories.length === 1) {
    return NextResponse.json(
      { error: "A project must keep at least one category" },
      { status: 400 }
    );
  }

  const inUse = await Task.find({ project: projectId, category: name })
    .select("taskNumber")
    .sort({ taskNumber: 1 })
    .limit(11);
  if (inUse.length > 0) {
    const keys = inUse.slice(0, 10).map((t) => `${project.key}-${t.taskNumber}`);
    const suffix = inUse.length > 10 ? " and more" : "";
    return NextResponse.json(
      { error: `Category "${name}" is still used by ${keys.join(", ")}${suffix}` },
      { status: 400 }
    );
  }

  project.categories = categories.filter((c) => c.name !== name);
  await project.save();

  logProjectAudit(projectId, user._id, "settings_updated", `Category removed: ${name}`);

  return NextResponse.json(project.categories);
});

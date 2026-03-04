import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.taskTemplates || []);
});

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { name, title, description, difficulty, category, component, acceptanceCriteria } =
    await request.json();

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Template name is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const templates = project.taskTemplates || [];
  if (templates.some((t) => t.name.toLowerCase() === name.trim().toLowerCase())) {
    return NextResponse.json({ error: "Template with this name already exists" }, { status: 409 });
  }

  templates.push({
    name: name.trim(),
    title: title || "",
    description: description || "",
    difficulty: difficulty || "M",
    category: category || "user-story",
    component: component || "",
    acceptanceCriteria: acceptanceCriteria || "",
  } as typeof templates[number]);
  project.taskTemplates = templates;
  await project.save();

  return NextResponse.json(project.taskTemplates, { status: 201 });
});

export const PUT = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { templateId, ...updates } = await request.json();
  if (!templateId) {
    return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const template = (project.taskTemplates || []).find(
    (t) => t._id.toString() === templateId
  );
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const allowed = ["name", "title", "description", "difficulty", "category", "component", "acceptanceCriteria"];
  for (const field of allowed) {
    if (updates[field] !== undefined) {
      (template as unknown as Record<string, unknown>)[field] = updates[field];
    }
  }

  await project.save();
  return NextResponse.json(project.taskTemplates);
});

export const DELETE = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { templateId } = await request.json();
  if (!templateId) {
    return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  project.taskTemplates = (project.taskTemplates || []).filter(
    (t) => t._id.toString() !== templateId
  );
  await project.save();

  return NextResponse.json(project.taskTemplates);
});

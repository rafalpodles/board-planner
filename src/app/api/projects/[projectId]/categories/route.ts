import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
// A category name lands in the PM's SYSTEM prompt, and any member can write one (BP-321)
import { hasControlCharacters } from "@/lib/identifiers";
import { withProjectAccess, withProjectOwner } from "@/lib/middleware";
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

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { name, color } = await request.json();
  if (!name || typeof name !== "string" || !name.trim() || name.trim().length > 50) {
    return NextResponse.json(
      { error: "Category name is required (max 50 chars)" },
      { status: 400 }
    );
  }
  if (hasControlCharacters(name)) {
    return NextResponse.json(
      { error: "Category name cannot contain control characters" },
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

export const PATCH = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { name, newName, color } = await request.json();
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const renaming = typeof newName === "string" && newName.trim() && newName.trim() !== name;
  const target = renaming ? newName.trim() : name;
  if (renaming && target.length > 50) {
    return NextResponse.json({ error: "Category name is too long (max 50 chars)" }, { status: 400 });
  }
  if (renaming && hasControlCharacters(target)) {
    return NextResponse.json(
      { error: "Category name cannot contain control characters" },
      { status: 400 }
    );
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const categories = project.categories || [];
  const current = categories.find((c) => c.name === name);
  if (!current) {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }
  // Nothing here can tell this request's own half-finished rename from somebody else's
  // category, and guessing wrong merges two categories and destroys one. Refuse. A
  // failure part-way leaves a spare category to delete by hand, which is recoverable.
  if (
    renaming &&
    categories.some((c) => c.name !== name && c.name.toLowerCase() === target.toLowerCase())
  ) {
    return NextResponse.json({ error: "Category already exists" }, { status: 409 });
  }

  if (!renaming) {
    if (color) current.color = color;
    await project.save();
    logProjectAudit(projectId, user._id, "settings_updated", `Category recoloured: ${name}`);
    return NextResponse.json(project.categories);
  }

  // Tasks store the category by name and are validated against this list, so a rename
  // that is not carried across them does not orphan those tasks quietly — it makes them
  // fail to save. There are no transactions here, so the rename runs through a state
  // where BOTH names are valid: whichever write fails, every task still holds a name the
  // project offers, and re-running the request finishes the job.
  categories.push({
    name: target,
    color: color || current.color,
  } as typeof categories[number]);
  project.categories = categories;
  await project.save();

  await Task.updateMany({ project: projectId, category: name }, { $set: { category: target } });

  project.categories = (project.categories || []).filter((c) => c.name !== name);
  for (const template of project.taskTemplates || []) {
    if (template.category === name) template.category = target;
  }
  await project.save();

  logProjectAudit(projectId, user._id, "settings_updated", `Category renamed: ${name} → ${target}`);

  return NextResponse.json(project.categories);
});

export const DELETE = withProjectOwner(async (request, { params, user }) => {
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

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import {
  MAX_TASK_TEMPLATES,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  TEMPLATE_NAME_MAX_LENGTH,
} from "@/lib/identifiers";

interface StoredTemplate {
  _id: { toString(): string };
  name: string;
}

/**
 * The same rules on both writers.
 *
 * They used to differ: `POST` refused a blank, duplicate or non-string name and `PUT` wrote
 * whatever the body held, because the update walked a field list and assigned. A template is
 * offered by name, so a duplicate is indistinguishable at the only moment anybody picks one and a
 * blank name is a row that cannot be picked at all (BP-716).
 *
 * The text bounds are the task's own: a template is copied into a task, so anything looser here
 * is just the long way round to the limit that route enforces.
 */
function templateProblem(
  body: Record<string, unknown>,
  existing: StoredTemplate[],
  self?: StoredTemplate
): string | null {
  if (body.name !== undefined) {
    const name = body.name;
    if (typeof name !== "string" || !name.trim()) return "Template name is required";
    if (name.trim().length > TEMPLATE_NAME_MAX_LENGTH) {
      return `Template name must be ${TEMPLATE_NAME_MAX_LENGTH} characters or less`;
    }
    const taken = existing.some(
      (t) =>
        t.name.toLowerCase() === name.trim().toLowerCase() &&
        (!self || t._id.toString() !== self._id.toString())
    );
    if (taken) return "Template with this name already exists";
  }

  for (const [field, max] of [
    ["title", TASK_TITLE_MAX_LENGTH],
    ["description", TASK_DESCRIPTION_MAX_LENGTH],
    ["acceptanceCriteria", TASK_DESCRIPTION_MAX_LENGTH],
    ["category", TEMPLATE_NAME_MAX_LENGTH],
  ] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${field} must be a string`;
    if (value.length > max) return `${field} must be ${max.toLocaleString("en-US")} characters or less`;
  }

  return null;
}

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();
  const { name, title, description, category, acceptanceCriteria } = body;

  if (name === undefined) {
    return NextResponse.json({ error: "Template name is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const templates = (project.taskTemplates || []) as unknown as StoredTemplate[];
  const problem = templateProblem(body, templates);
  if (problem) {
    // A name already taken is a conflict; everything else here is a malformed request.
    const status = problem.endsWith("already exists") ? 409 : 400;
    return NextResponse.json({ error: problem }, { status });
  }

  // The ceiling in the write's own filter rather than a count read above it, for the reason the
  // categories route gives: every racer sees the same pre-write length (BP-716).
  const added = await Project.findOneAndUpdate(
    { _id: projectId, [`taskTemplates.${MAX_TASK_TEMPLATES - 1}`]: { $exists: false } },
    {
      $push: {
        taskTemplates: {
          name: name.trim(),
          title: title || "",
          description: description || "",
          category: category || "user-story",
          acceptanceCriteria: acceptanceCriteria || "",
        },
      },
    },
    { returnDocument: "after" }
  );
  if (!added) {
    return NextResponse.json(
      { error: `A project may have at most ${MAX_TASK_TEMPLATES} templates` },
      { status: 400 }
    );
  }

  logProjectAudit(projectId, user._id, "template_added", name.trim());

  return NextResponse.json(added.taskTemplates, { status: 201 });
});

export const PUT = withProjectAccess(async (request, { params, user }) => {
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

  const problem = templateProblem(
    updates,
    (project.taskTemplates || []) as unknown as StoredTemplate[],
    template as unknown as StoredTemplate
  );
  if (problem) {
    const status = problem.endsWith("already exists") ? 409 : 400;
    return NextResponse.json({ error: problem }, { status });
  }

  const allowed = ["name", "title", "description", "category", "acceptanceCriteria"];
  for (const field of allowed) {
    if (updates[field] !== undefined) {
      (template as unknown as Record<string, unknown>)[field] =
        field === "name" ? (updates[field] as string).trim() : updates[field];
    }
  }

  await project.save();

  logProjectAudit(projectId, user._id, "template_updated", template.name);

  return NextResponse.json(project.taskTemplates);
});

export const DELETE = withProjectOwner(async (request, { params, user }) => {
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

  const removed = (project.taskTemplates || []).find((t) => t._id.toString() === templateId);
  project.taskTemplates = (project.taskTemplates || []).filter(
    (t) => t._id.toString() !== templateId
  );
  await project.save();

  if (removed) logProjectAudit(projectId, user._id, "template_removed", removed.name);

  return NextResponse.json(project.taskTemplates);
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { check } from "@/lib/grants";
import {
  isOptionField,
  normalizeOptions,
  optionIdsDropped,
  parseOptions,
  MAX_FIELD_NAME_LENGTH,
} from "@/lib/custom-fields";

export const PATCH = withProjectAccess(async (request, { params, user }) => {
  const { projectId, fieldId } = await params;
  await connectDB();

  const body = await request.json();
  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const field = (project.customFields || []).find((f) => f._id.toString() === fieldId);
  if (!field) {
    return NextResponse.json({ error: "Field not found" }, { status: 404 });
  }

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      return NextResponse.json({ error: "Field name is required" }, { status: 400 });
    }
    if (name.length > MAX_FIELD_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Field name must be ${MAX_FIELD_NAME_LENGTH} characters or less` },
        { status: 400 }
      );
    }
    const clash = (project.customFields || []).some(
      (f) => f._id.toString() !== fieldId && f.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
    }
    field.name = name;
  }

  // Dropping a saved option erases it from every task, like the owner-gated DELETE; archiving keeps values
  if (
    body.options !== undefined &&
    isOptionField(field) &&
    optionIdsDropped(normalizeOptions(field.options), body.options) &&
    !(await check(user, projectId, "admin"))
  ) {
    return NextResponse.json(
      { error: "Only a project owner can remove an option a field already has" },
      { status: 403 }
    );
  }

  if (body.options !== undefined && isOptionField(field)) {
    // Existing options are passed in so an edit keeps their ids, which is what
    // holds a renamed option onto every task that has it
    const parsed = parseOptions(body.options, normalizeOptions(field.options));
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    field.options = parsed.options!;
  }

  for (const flag of ["required", "showOnCard", "showInList", "filterable", "archived"] as const) {
    if (body[flag] !== undefined) field[flag] = !!body[flag];
  }
  if (body.order !== undefined && Number.isFinite(Number(body.order))) {
    field.order = Number(body.order);
  }

  // An archived field vanishes from every picker while the designation would survive,
  // so archiving strands the pointer exactly like deleting the field does.
  if (field.archived && project.estimateFieldId === fieldId) {
    project.estimateFieldId = "";
  }

  project.markModified("customFields");
  await project.save();

  return NextResponse.json(project.customFields);
});

export const DELETE = withProjectOwner(async (_request, { params }) => {
  const { projectId, fieldId } = await params;
  await connectDB();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  project.customFields = (project.customFields || []).filter(
    (f) => f._id.toString() !== fieldId
  );
  if (project.estimateFieldId === fieldId) {
    project.estimateFieldId = "";
  }
  await project.save();

  // Clean up orphaned values from all tasks in this project
  await Task.updateMany(
    { project: projectId },
    { $unset: { [`customFieldValues.${fieldId}`]: "" } }
  );

  return NextResponse.json(project.customFields);
});

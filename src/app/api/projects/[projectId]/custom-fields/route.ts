import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { CUSTOM_FIELD_TYPES, CustomFieldType } from "@/types";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.customFields || []);
});

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();
  const { name, fieldType, options, required: isRequired } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Field name is required" }, { status: 400 });
  }
  if (!fieldType || !CUSTOM_FIELD_TYPES.includes(fieldType as CustomFieldType)) {
    return NextResponse.json({ error: "Invalid field type" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const fields = project.customFields || [];
  if (fields.some((f) => f.name.toLowerCase() === name.trim().toLowerCase())) {
    return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields.push({
    name: name.trim(),
    fieldType,
    options: fieldType === "dropdown" && Array.isArray(options) ? options : [],
    required: !!isRequired,
  } as any);
  project.customFields = fields;
  await project.save();

  return NextResponse.json(project.customFields, { status: 201 });
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { CUSTOM_FIELD_TYPES, CustomFieldType } from "@/types";

const MAX_FIELDS = 50;
const MAX_NAME_LENGTH = 100;

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
  if (name.trim().length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: `Field name must be ${MAX_NAME_LENGTH} characters or less` }, { status: 400 });
  }
  if (!fieldType || !CUSTOM_FIELD_TYPES.includes(fieldType as CustomFieldType)) {
    return NextResponse.json({ error: "Invalid field type" }, { status: 400 });
  }

  // Validate dropdown options
  let parsedOptions: string[] = [];
  if (fieldType === "dropdown") {
    if (!Array.isArray(options) || options.length === 0) {
      return NextResponse.json({ error: "Dropdown fields require at least one option" }, { status: 400 });
    }
    parsedOptions = options
      .filter((o: unknown) => typeof o === "string" && o.trim())
      .map((o: string) => o.trim());
    if (parsedOptions.length === 0) {
      return NextResponse.json({ error: "Dropdown options must be non-empty strings" }, { status: 400 });
    }
    if (new Set(parsedOptions).size !== parsedOptions.length) {
      return NextResponse.json({ error: "Dropdown options must be unique" }, { status: 400 });
    }
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const fields = project.customFields || [];
  if (fields.length >= MAX_FIELDS) {
    return NextResponse.json({ error: `Maximum ${MAX_FIELDS} custom fields per project` }, { status: 400 });
  }
  if (fields.some((f) => f.name.toLowerCase() === name.trim().toLowerCase())) {
    return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields.push({
    name: name.trim(),
    fieldType,
    options: parsedOptions,
    required: !!isRequired,
  } as any);
  project.customFields = fields;
  await project.save();

  return NextResponse.json(project.customFields, { status: 201 });
});

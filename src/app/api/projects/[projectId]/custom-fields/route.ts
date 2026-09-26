import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { CUSTOM_FIELD_TYPES, CustomFieldType } from "@/types";
import {
  isOptionField,
  parseOptions,
  FIELD_NAME_COLLATION,
  MAX_FIELD_NAME_LENGTH,
} from "@/lib/custom-fields";

const MAX_FIELDS = 50;

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.customFields || []);
});

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();
  const {
    name,
    fieldType,
    options,
    required: isRequired,
    showOnCard,
    showInList,
    filterable,
  } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Field name is required" }, { status: 400 });
  }
  if (name.trim().length > MAX_FIELD_NAME_LENGTH) {
    return NextResponse.json({ error: `Field name must be ${MAX_FIELD_NAME_LENGTH} characters or less` }, { status: 400 });
  }
  if (!fieldType || !CUSTOM_FIELD_TYPES.includes(fieldType as CustomFieldType)) {
    return NextResponse.json({ error: "Invalid field type" }, { status: 400 });
  }

  let parsedOptions: ReturnType<typeof parseOptions>["options"] = [];
  if (isOptionField({ fieldType })) {
    if (!Array.isArray(options) || options.length === 0) {
      return NextResponse.json(
        { error: "This field type needs at least one option" },
        { status: 400 }
      );
    }
    const parsed = parseOptions(options);
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    parsedOptions = parsed.options;
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const fields = project.customFields || [];
  if (fields.some((f) => f.name.toLowerCase() === name.trim().toLowerCase())) {
    return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
  }

  // The ceiling goes in the write's own filter, not in a count read against the document
  // above: every concurrent racer sees the same pre-write length, so a check up there
  // bounds nothing — the same fix already applied to the webhook writers (BP-719).
  // The name as well: the check above read the list, and another add may have taken it since
  const updated = await Project.findOneAndUpdate(
    {
      _id: projectId,
      [`customFields.${MAX_FIELDS - 1}`]: { $exists: false },
      customFields: { $not: { $elemMatch: { name: name.trim() } } },
    },
    {
      $push: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customFields: {
          name: name.trim(),
          fieldType,
          options: parsedOptions,
          required: !!isRequired,
          // A new field lands at the end of the form rather than jumping to the top
          order: fields.length,
          showOnCard: !!showOnCard,
          showInList: !!showInList,
          filterable: !!filterable,
          archived: false,
        } as any,
      },
    },
    { returnDocument: "after", collation: FIELD_NAME_COLLATION }
  );
  if (!updated) {
    // A miss is the ceiling, the name taken since the read, or the project deleted in between,
    // and the three answer differently
    const current = await Project.findById(projectId).select("customFields").lean();
    if (!current) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if ((current.customFields || []).some((f) => f.name.toLowerCase() === name.trim().toLowerCase())) {
      return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: `Maximum ${MAX_FIELDS} custom fields per project` }, { status: 400 });
  }

  logProjectAudit(projectId, user._id, "settings_updated", `Custom field added: ${name.trim()} (${fieldType})`);

  return NextResponse.json(updated.customFields, { status: 201 });
});

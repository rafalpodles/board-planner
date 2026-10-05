import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { logProjectAudit } from "@/lib/projectAudit";
import { customFieldChanges } from "@/lib/settings-audit";
import { canonicalObjectId } from "@/lib/object-id";
import {
  isOptionField,
  MAX_OPTIONS,
  normalizeOptions,
  parseOptions,
  sameFieldName,
} from "@/lib/custom-fields";

// Adds one option to the end of a dropdown or multiselect field in one update. The field's own PATCH
// takes the whole list, and an editor that sends it back with one more row undoes an option added
// since it read. Nothing here can remove or reorder an option, so no task value is put at risk.
export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId, fieldId: rawFieldId } = await params;
  await connectDB();

  const fieldId = canonicalObjectId(rawFieldId);
  if (!fieldId) return NextResponse.json({ error: "Field not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { value?: unknown; color?: unknown } | null;
  if (typeof body?.value !== "string") {
    return NextResponse.json({ error: "Every option needs a value" }, { status: 400 });
  }
  const parsed = parseOptions([{ value: body.value, color: typeof body.color === "string" ? body.color : undefined }]);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const project = await db.Project.findById(projectId).select("customFields").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const field = (project.customFields || []).find((f) => String(f._id) === fieldId);
  if (!field) return NextResponse.json({ error: "Field not found" }, { status: 404 });
  if (!isOptionField(field)) {
    return NextResponse.json({ error: "Only a dropdown or multiselect field has options" }, { status: 400 });
  }

  const existing = normalizeOptions(field.options);
  const option = { ...parsed.options![0], order: existing.length };
  const taken = (id: string, value: string) =>
    existing.some((o) => o.id === id || o.value.trim().toLowerCase() === value.toLowerCase());
  if (taken(option.id, option.value)) {
    return NextResponse.json({ error: `"${option.value}" is already an option of ${field.name}` }, { status: 409 });
  }

  // The ceiling and the name are in the write's own filter: the read above is a snapshot, and two
  // adds racing would both pass it. A pre-CP-211 option is a bare string, so it is matched as one too
  const sameValue = sameFieldName(option.value);
  const before = await db.Project.findOneAndUpdate(
    {
      _id: projectId,
      customFields: {
        $elemMatch: {
          _id: fieldId,
          [`options.${MAX_OPTIONS - 1}`]: { $exists: false },
          $nor: [{ options: { $elemMatch: { value: sameValue } } }, { options: { $elemMatch: sameValue } }],
        },
      },
    },
    { $push: { "customFields.$.options": option } },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    const current = await db.Project.findById(projectId).select("customFields").lean();
    const now = (current?.customFields || []).find((f) => String(f._id) === fieldId);
    if (!now) return NextResponse.json({ error: "Field not found" }, { status: 404 });
    if (normalizeOptions(now.options).length >= MAX_OPTIONS) {
      return NextResponse.json({ error: `At most ${MAX_OPTIONS} options` }, { status: 400 });
    }
    return NextResponse.json({ error: `"${option.value}" is already an option of ${field.name}` }, { status: 409 });
  }

  const was = before.customFields.find((f) => String(f._id) === fieldId)!;
  const after = { ...was, options: [...normalizeOptions(was.options), option] };
  const lines = customFieldChanges(was, after);
  if (lines.length > 0) logProjectAudit(db, projectId, user._id, "settings_updated", lines);

  return NextResponse.json({ option, field: after }, { status: 201 });
});

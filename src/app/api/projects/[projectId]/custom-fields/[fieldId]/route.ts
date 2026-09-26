import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { check } from "@/lib/grants";
import { logProjectAudit } from "@/lib/projectAudit";
import { customFieldChanges } from "@/lib/settings-audit";
import { projectWriteImages } from "@/lib/project-write-images";
import { canonicalObjectId } from "@/lib/object-id";
import {
  isOptionField,
  normalizeOptions,
  optionIdsDropped,
  parseOptions,
  sameFieldName,
  MAX_FIELD_NAME_LENGTH,
} from "@/lib/custom-fields";

const FLAGS = ["required", "showOnCard", "showInList", "filterable", "archived"] as const;

// Only while it still points at this field when the write runs
async function clearEstimateField(projectId: string, fieldId: string): Promise<boolean> {
  const cleared = await Project.updateOne(
    { _id: projectId, estimateFieldId: fieldId },
    { $set: { estimateFieldId: "" } }
  );
  return cleared.modifiedCount > 0;
}

export const PATCH = withProjectAccess(async (request, { params, user }) => {
  const { projectId, fieldId: rawFieldId } = await params;
  await connectDB();

  const fieldId = canonicalObjectId(rawFieldId);
  if (!fieldId) {
    return NextResponse.json({ error: "Field not found" }, { status: 404 });
  }
  const body = await request.json();
  const project = await Project.findById(projectId).select("customFields").lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const field = (project.customFields || []).find((f) => String(f._id) === fieldId);
  if (!field) {
    return NextResponse.json({ error: "Field not found" }, { status: 404 });
  }

  const changes: Record<string, unknown> = {};
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
    // Only a new name can clash: a form re-sending the stored one saves a legacy twin's other settings
    const clash =
      name !== field.name &&
      (project.customFields || []).some(
        (f) => String(f._id) !== fieldId && f.name.toLowerCase() === name.toLowerCase()
      );
    if (clash) {
      return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
    }
    changes.name = name;
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
    changes.options = parsed.options!;
  }

  for (const flag of FLAGS) {
    if (body[flag] !== undefined) changes[flag] = !!body[flag];
  }
  if (body.order !== undefined && Number.isFinite(Number(body.order))) {
    changes.order = Number(body.order);
  }

  // This field's own paths only: saving the whole list put back a field added or edited meanwhile.
  // A new name is checked in the write too, since another rename may have taken it since the read.
  const renamed = changes.name !== undefined && changes.name !== field.name;
  const before = await Project.findOneAndUpdate(
    {
      _id: projectId,
      "customFields._id": fieldId,
      ...(renamed
        ? {
            customFields: {
              $not: { $elemMatch: { _id: { $ne: fieldId }, name: sameFieldName(changes.name as string) } },
            },
          }
        : {}),
    },
    {
      $set: Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [`customFields.$.${key}`, value])
      ),
    },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    if (renamed) {
      const current = await Project.findById(projectId).select("customFields").lean();
      if ((current?.customFields || []).some((f) => String(f._id) === fieldId)) {
        return NextResponse.json({ error: "Field with this name already exists" }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Field not found" }, { status: 404 });
  }

  const index = before.customFields.findIndex((f) => String(f._id) === fieldId);
  const was = before.customFields[index];
  // An archived field vanishes from every picker while the designation would survive,
  // so archiving strands the pointer exactly like deleting the field does.
  const estimateCleared =
    (changes.archived ?? was.archived) === true && (await clearEstimateField(projectId, fieldId));

  const lines = customFieldChanges(was, { ...was, ...changes });
  if (estimateCleared) lines.push(`Estimate field: ${was.name} → none`);
  if (lines.length > 0) logProjectAudit(projectId, user._id, "settings_updated", lines);

  const { after } = projectWriteImages(
    before,
    Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [`customFields.${index}.${key}`, value])
    )
  );
  return NextResponse.json(after.toObject().customFields);
});

export const DELETE = withProjectOwner(async (_request, { params, user }) => {
  const { projectId, fieldId: rawFieldId } = await params;
  await connectDB();

  const fieldId = canonicalObjectId(rawFieldId);
  if (!fieldId) {
    const project = await Project.findById(projectId).select("customFields");
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json(project.customFields);
  }

  const before = await Project.findOneAndUpdate(
    { _id: projectId },
    { $pull: { customFields: { _id: fieldId } } },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const removed = (before.customFields || []).find((f) => String(f._id) === fieldId);
  const estimateCleared = await clearEstimateField(projectId, fieldId);

  // Clean up orphaned values from all tasks in this project
  await Task.updateMany(
    { project: projectId },
    { $unset: { [`customFieldValues.${fieldId}`]: "" } }
  );

  if (removed) {
    logProjectAudit(projectId, user._id, "settings_updated", [
      `Custom field removed: ${removed.name}`,
      ...(estimateCleared ? [`Estimate field: ${removed.name} → none`] : []),
    ]);
  }

  const { after } = projectWriteImages(before, {
    customFields: (before.customFields || []).filter((f) => f !== removed),
  });
  return NextResponse.json(after.toObject().customFields);
});

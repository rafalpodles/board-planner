import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { logProjectAudit } from "@/lib/projectAudit";
import { DEFAULT_PROJECT_COLUMNS } from "@/types";
import { columnLabelOrRefusal, effectiveColumns } from "@/lib/columns";

// Renames one column in place by its id. The id is what every task's status holds, so it never
// moves; PUT replaces the whole list from a read, which puts back a column added or recoloured since.
export const PATCH = withProjectOwner(async (request, { params, user, db }) => {
  const { projectId, columnId } = await params;
  await connectDB();

  const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
  const label = columnLabelOrRefusal(body?.label);
  if ("error" in label) return NextResponse.json({ error: label.error }, { status: 400 });

  let before = await db.Project.findOneAndUpdate(
    { _id: projectId, "columns.id": columnId },
    { $set: { "columns.$[c].label": label.label } },
    { arrayFilters: [{ "c.id": columnId }], returnDocument: "before" }
  ).lean();

  if (!before) {
    const current = await db.Project.findById(projectId).select("columns").lean();
    if (!current) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // A board stored with `columns: []` is shown the seven defaults, and a column of one can be renamed
    const unseeded = (current.columns ?? []).length === 0;
    if (!unseeded || !DEFAULT_PROJECT_COLUMNS.some((c) => c.id === columnId)) {
      return NextResponse.json({ error: "Column not found" }, { status: 404 });
    }
    before = await db.Project.findOneAndUpdate(
      { _id: projectId, "columns.0": { $exists: false } },
      {
        $set: {
          columns: DEFAULT_PROJECT_COLUMNS.map((c) => (c.id === columnId ? { ...c, label: label.label } : c)),
        },
      },
      { returnDocument: "before" }
    ).lean();
    if (!before) {
      return NextResponse.json(
        { error: "The board's columns changed while this was being renamed — nothing was written, try again" },
        { status: 409 }
      );
    }
  }

  const columns = effectiveColumns(before.columns);
  const was = columns.find((c) => c.id === columnId)!;
  if (was.label !== label.label) {
    logProjectAudit(db, projectId, user._id, "settings_updated", `Column renamed: ${was.label} → ${label.label} (${columnId})`);
  }

  return NextResponse.json(columns.map((c) => (c.id === columnId ? { ...c, label: label.label } : c)));
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { logProjectAudit } from "@/lib/projectAudit";
import { COLUMN_ROLES, ColumnRole, ROLE_LABELS } from "@/types";
import { effectiveColumns } from "@/lib/columns";

const MAX_COLUMNS = 12;
const MAX_LABEL = 40;

// What a board loses with its last column of the role, in the refusal's own words
const LOAD_BEARING: Partial<Record<ColumnRole, string>> = {
  done: "sprint progress reads 0% for ever and no worker will take a task from it",
  active: "a worker has nowhere to move a task it takes, so it claims nothing",
};

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

export const GET = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "columns");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  // The same board the PUT below judges a save against. Answering the raw array here left a
  // caller that is not this app's own editor unable to learn a legacy board's ids at all — no
  // other endpoint carries them — so its only possible PUT described the seven by label, which
  // the PUT reads as removing `todo` and adding `to_do` (BP-523).
  return NextResponse.json(effectiveColumns(project.columns));
});

export const PUT = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { columns } = await request.json();
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) {
    return NextResponse.json(
      { error: `columns must be an array of 1-${MAX_COLUMNS} entries` },
      { status: 400 }
    );
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The board as everything else sees it, and as this endpoint's role rules always did. A
  // project stored with `columns: []` predates column seeding and is shown the built-in seven
  // by every reader — the editor on this screen included, which then sends those seven back.
  // Reading the raw array here re-slugged the ids it had just been given and judged removals
  // against a board nobody can see (BP-523).
  const current = effectiveColumns(project.columns);
  const existingIds = new Set(current.map((c) => c.id));
  const usedIds = new Set<string>();
  const clean: { id: string; label: string; color: string; role: ColumnRole; order: number; triggersPmReview: boolean }[] = [];

  for (const [index, raw] of columns.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return NextResponse.json({ error: "columns entries must be objects" }, { status: 400 });
    }
    const label = String(raw.label ?? "").trim();
    if (!label || label.length > MAX_LABEL) {
      return NextResponse.json(
        { error: `Column labels must be 1-${MAX_LABEL} chars` },
        { status: 400 }
      );
    }
    if (!COLUMN_ROLES.includes(raw.role)) {
      return NextResponse.json(
        { error: `Column role must be one of: ${COLUMN_ROLES.join(", ")}` },
        { status: 400 }
      );
    }
    // Existing columns keep their immutable id; new ones get a slug from the label
    let id = typeof raw.id === "string" && existingIds.has(raw.id) ? raw.id : slugify(label);
    if (!id) {
      return NextResponse.json(
        { error: `Column label "${label}" produces an empty id` },
        { status: 400 }
      );
    }
    let candidate = id;
    let n = 2;
    while (usedIds.has(candidate)) {
      candidate = `${id}_${n++}`;
    }
    id = candidate;
    usedIds.add(id);

    clean.push({
      id,
      label,
      color: typeof raw.color === "string" && raw.color ? raw.color : "#6b7280",
      role: raw.role as ColumnRole,
      order: index,
      triggersPmReview: raw.triggersPmReview === true,
    });
  }

  // Before the role rule below: a column that still holds tasks is the more local refusal, and
  // the one whose fix — move the tasks — the person has to make first whatever else is wrong
  const removed = current.filter((c) => !usedIds.has(c.id));
  for (const col of removed) {
    const inUse = await Task.find({ project: projectId, status: col.id })
      .select("taskNumber")
      .sort({ taskNumber: 1 })
      .limit(11);
    if (inUse.length > 0) {
      const keys = inUse.slice(0, 10).map((t) => `${project.key}-${t.taskNumber}`);
      const suffix = inUse.length > 10 ? " and more" : "";
      return NextResponse.json(
        { error: `Column "${col.label}" still has tasks: ${keys.join(", ")}${suffix}` },
        { status: 400 }
      );
    }
  }

  /**
   * Two roles are load-bearing across the product, and both used to fail silently when a board
   * lost its last column carrying them. `done`: a sprint's `doneCount` and the sprint page's
   * progress both read 0 for ever (BP-311). `active`: the dashboard's In Progress read 0, and the
   * claim had nowhere to move a task into, so the worker claimed nothing and reported an empty
   * queue (BP-512). Nothing said so, anywhere, and nothing in the audit log either. `approved`
   * and `review` matter only to a worker, which now refuses the claim naming the missing role, so
   * a board that runs no worker may still do without them.
   *
   * Refused only as a **transition**, never as a state. A board that already lacks one of these
   * must keep being able to save every other change — otherwise this would lock such a board out
   * of the very screen where it is repaired, and out of every unrelated column edit besides. That
   * also means no production census is needed to make this safe: the rule refuses the act that
   * creates the problem, never the board that already has it.
   */
  for (const [role, loses] of Object.entries(LOAD_BEARING) as [ColumnRole, string][]) {
    const had = current.some((c) => c.role === role);
    const willHave = clean.some((c) => c.role === role);
    if (had && !willHave) {
      const { label } = ROLE_LABELS[role];
      return NextResponse.json(
        {
          error:
            `A board needs a column meaning ${label}. Without one, ${loses}. ` +
            `Give another column the ${label} role first, then remove this one.`,
        },
        { status: 400 }
      );
    }
  }

  project.columns = clean as unknown as typeof project.columns;
  await project.save();

  logProjectAudit(
    projectId,
    user._id,
    "settings_updated",
    `Columns updated: ${clean.map((c) => c.label).join(", ")}`
  );

  return NextResponse.json(project.columns);
});

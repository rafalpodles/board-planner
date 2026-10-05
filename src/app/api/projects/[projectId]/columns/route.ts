import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { logProjectAudit } from "@/lib/projectAudit";
import { COLUMN_ROLES, ColumnRole, DEFAULT_PROJECT_COLUMNS, ROLE_LABELS } from "@/types";
import {
  columnIdsWithRole,
  columnLabelOrRefusal,
  effectiveColumns,
  freeColumnId,
  MAX_COLUMNS,
  MAX_COLUMN_LABEL as MAX_LABEL,
  slugify,
} from "@/lib/columns";

// What a board loses with its last column of the role, in the refusal's own words
const LOAD_BEARING: Partial<Record<ColumnRole, string>> = {
  done: "sprint progress reads 0% for ever and no worker will take a task from it",
  active: "a worker has nowhere to move a task it takes, so it claims nothing",
};

export const GET = withProjectOwner(async (_request, { params, db }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await db.Project.findById(projectId, "columns");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(project.columns || []);
});

const APPEND_ATTEMPTS = 3;

// Adds one column to the end of the board in one update. PUT replaces the whole list from a read, so
// a column added or renamed between that read and the write is put back the way it was; this does
// not send the list. The ceiling and the id are in the write's own filter, for the reason the
// category and checklist adds carry theirs: every racer sees the same pre-write board.
export const POST = withProjectOwner(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const body = (await request.json().catch(() => null)) as
    | { label?: unknown; role?: unknown; color?: unknown }
    | null;
  const label = columnLabelOrRefusal(body?.label);
  if ("error" in label) return NextResponse.json({ error: label.error }, { status: 400 });
  if (!COLUMN_ROLES.includes(body?.role as ColumnRole)) {
    return NextResponse.json(
      { error: `Column role must be one of: ${COLUMN_ROLES.join(", ")}` },
      { status: 400 }
    );
  }
  const color = typeof body?.color === "string" && body.color ? body.color : "#6b7280";

  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const project = await db.Project.findById(projectId).select("columns").lean();
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const stored = project.columns ?? [];
    const existing = effectiveColumns(stored);
    if (existing.length >= MAX_COLUMNS) {
      return NextResponse.json({ error: `A board may have at most ${MAX_COLUMNS} columns` }, { status: 400 });
    }
    const id = freeColumnId(label.label, existing.map((c) => c.id));
    if (!id) {
      return NextResponse.json(
        { error: `Column label "${label.label}" produces an empty id` },
        { status: 400 }
      );
    }
    const column = {
      id,
      label: label.label,
      color,
      role: body!.role as ColumnRole,
      order: Math.max(...existing.map((c) => c.order)) + 1,
      triggersPmReview: false,
    };

    // A board stored with `columns: []` is shown the seven defaults, so the first column added to it
    // has to keep them: a push onto the empty array would leave a board of one
    const added =
      stored.length === 0
        ? await db.Project.findOneAndUpdate(
            { _id: projectId, "columns.0": { $exists: false } },
            { $set: { columns: [...DEFAULT_PROJECT_COLUMNS, column] } },
            { returnDocument: "after" }
          )
        : await db.Project.findOneAndUpdate(
            {
              _id: projectId,
              "columns.0": { $exists: true },
              [`columns.${MAX_COLUMNS - 1}`]: { $exists: false },
              columns: { $not: { $elemMatch: { id } } },
            },
            { $push: { columns: column } },
            { returnDocument: "after" }
          );
    if (!added) continue;

    logProjectAudit(
      db,
      projectId,
      user._id,
      "settings_updated",
      `Column added: ${column.label} (${column.id}, ${ROLE_LABELS[column.role].label})`
    );
    return NextResponse.json(effectiveColumns(added.columns), { status: 201 });
  }

  return NextResponse.json(
    { error: "The board's columns changed while this was being added — nothing was written, try again" },
    { status: 409 }
  );
});

export const PUT = withProjectOwner(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const { columns } = await request.json();
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) {
    return NextResponse.json(
      { error: `columns must be an array of 1-${MAX_COLUMNS} entries` },
      { status: 400 }
    );
  }

  const project = await db.Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The columns this board actually has, which for one stored with `columns: []` is the seven
  // defaults everybody is shown — this editor included. Reading the raw array here made every
  // incoming id a stranger on such a board: the defaults could not be claimed, so keeping one was
  // indistinguishable from deleting it, and the in-use check below never saw what was leaving
  // (BP-514).
  const existing = effectiveColumns(project.columns);
  const existingIds = new Set(existing.map((c) => c.id));
  // Every id the incoming board claims by identity, resolved before a slug is handed out
  const claims: string[] = columns
    .filter((raw) => typeof raw?.id === "string" && existingIds.has(raw.id))
    .map((raw) => raw.id as string);
  const claimed = new Set(claims);
  // Two rows naming one column contradict each other, and there is no reading of that worth
  // guessing at: served by "first one wins" it silently invents a column for the loser
  if (claimed.size !== claims.length) {
    return NextResponse.json(
      { error: "Two columns cannot claim the same id" },
      { status: 400 }
    );
  }
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
    // Off its own id, an entry is a stranger again and may not land on one somebody claimed
    while (usedIds.has(candidate) || (candidate !== raw.id && claimed.has(candidate))) {
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
  // Removed means nobody claimed it, not that its id went unused: a newcomer taking a
  // departing column's id used to hide the departure from the check below
  const removed = existing.filter((c) => !claimed.has(c.id));
  for (const col of removed) {
    const inUse = await db.Task.find({ project: projectId, status: col.id })
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
    // Through `effectiveColumns`, like every other reader: a project stored with `columns: []` is
    // shown the seven defaults everywhere — including this very editor — so reading the raw array
    // would answer "there was never a Done column" about a board whose admin can see one.
    const had = columnIdsWithRole(project, role).length > 0;
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
    db,
    projectId,
    user._id,
    "settings_updated",
    `Columns updated: ${clean.map((c) => `${c.label} (${c.id})`).join(", ")}`
  );

  return NextResponse.json(project.columns);
});

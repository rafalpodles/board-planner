import { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import type { ICustomField, IProjectColumn, Priority } from "@/types";
import { defaultStatusFor, getProjectColumns } from "@/lib/columns";
import { activeFields, matchOptionValue, normalizeFields, validateCustomFieldValues } from "@/lib/custom-fields";
import { recipientsWithAccess } from "@/lib/grants";
import {
  COMMENT_BODY_MAX_LENGTH,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  stripControlCharacters,
} from "@/lib/identifiers";
import { logActivities } from "@/lib/activity";
import { actingThrough } from "@/lib/activity-source";
import { logProjectAudit } from "@/lib/projectAudit";
import type { ImportBundle, ImportComment, ImportMapping, ImportTask } from "./bundle";

export const IMPORT_CHUNK = 200;
const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "urgent"];

export type SkipReason = "no title";

export interface ImportReport {
  dryRun: boolean;
  source: string;
  total: number;
  created: number;
  updated: number;
  comments: { created: number; updated: number };
  skipped: { id: string; reason: SkipReason }[];
  dropped: { id: string; field: string; value: string; reason: string }[];
  truncated: { id: string; field: string }[];
  unmapped: { statuses: string[]; users: string[]; types: string[] };
  notImported: { id: string; what: string }[];
  processed: number;
  complete: boolean;
  error?: string;
}

interface Board {
  columns: IProjectColumn[];
  categories: string[];
  fields: ICustomField[];
  defaultStatus: string;
  defaultCategory: string;
}

interface Resolved {
  ref: string;
  title: string;
  description: string;
  status: string;
  category: string;
  priority: Priority;
  assignee: Types.ObjectId | null;
  createdAt: Date | null;
  completedAt: Date | null;
  customFieldValues: Record<string, unknown>;
  comments: { ref: string; body: string; author: Types.ObjectId; createdAt: Date | null }[];
}

const shown = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

function clip(report: ImportReport, id: string, field: string, text: string, max: number): string {
  const clean = stripControlCharacters(text).trim();
  if (clean.length <= max) return clean;
  report.truncated.push({ id, field });
  return clean.slice(0, max);
}

function instant(report: ImportReport, id: string, field: string, raw: string | undefined): Date | null {
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now()) {
    report.dropped.push({ id, field, value: shown(raw), reason: "not a date in the past" });
    return null;
  }
  return at;
}

// A source column, user or type maps through the mapping first, then by its own name
function byName<T extends string>(candidates: readonly T[], name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return candidates.find((c) => c.toLowerCase() === wanted);
}

function noteUnmapped(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

function resolveFields(report: ImportReport, task: ImportTask, board: Board): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(task.fields ?? {})) {
    const field = board.fields.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!field) {
      report.dropped.push({ id: task.id, field: name, value: shown(raw), reason: "no field of that name on this board" });
      continue;
    }
    if (raw === null || raw === undefined || raw === "") continue;
    let value: unknown = raw;
    if (field.fieldType === "dropdown") value = matchOptionValue(field, raw) ?? raw;
    if (field.fieldType === "multiselect" && Array.isArray(raw)) value = raw.map((v) => matchOptionValue(field, v) ?? v);
    if (field.fieldType === "number" && typeof raw === "string" && raw.trim() && !Number.isNaN(Number(raw))) value = Number(raw);
    const verdict = validateCustomFieldValues({ [String(field._id)]: value }, [{ ...field, required: false }]);
    if (!verdict.valid) {
      report.dropped.push({ id: task.id, field: field.name, value: shown(raw), reason: verdict.error ?? "not a valid value" });
      continue;
    }
    values[String(field._id)] = value;
  }
  return values;
}

async function resolveUsers(
  db: ScopedDb,
  projectId: string,
  bundle: ImportBundle,
  mapping: ImportMapping
): Promise<Map<string, Types.ObjectId | null>> {
  const names = new Set<string>();
  for (const task of bundle.tasks) {
    if (task.assignee) names.add(task.assignee);
    for (const comment of task.comments ?? []) if (comment.author) names.add(comment.author);
  }
  const wanted = new Map<string, string | null>();
  for (const name of names) {
    const mapped = mapping.users && Object.hasOwn(mapping.users, name) ? mapping.users[name] : name;
    wanted.set(name, mapped ? mapped.trim().toLowerCase() : null);
  }
  const usernames = [...new Set([...wanted.values()].filter((v): v is string => !!v))];
  const accounts = usernames.length
    ? await db.User.find({ username: { $in: usernames }, deactivatedAt: null }).select("_id username").lean<{ _id: Types.ObjectId; username: string }[]>()
    : [];
  const members = new Set(await recipientsWithAccess(db, accounts.map((a) => String(a._id)), projectId));
  const byUsername = new Map(accounts.filter((a) => members.has(String(a._id))).map((a) => [a.username, a._id]));
  return new Map([...wanted].map(([name, username]) => [name, username ? byUsername.get(username) ?? null : null]));
}

function resolveTask(
  report: ImportReport,
  task: ImportTask,
  board: Board,
  mapping: ImportMapping,
  users: Map<string, Types.ObjectId | null>,
  importer: Types.ObjectId
): Resolved | null {
  const title = clip(report, task.id, "title", task.title ?? "", TASK_TITLE_MAX_LENGTH);
  if (!title) {
    report.skipped.push({ id: task.id, reason: "no title" });
    return null;
  }
  const columnIds = board.columns.map((c) => c.id);
  let status = board.defaultStatus;
  if (task.status) {
    const mapped = mapping.statuses?.[task.status];
    const found =
      (mapped && columnIds.includes(mapped) ? mapped : undefined) ??
      byName(columnIds, task.status) ??
      board.columns.find((c) => c.label.trim().toLowerCase() === task.status!.trim().toLowerCase())?.id;
    if (found) status = found;
    else noteUnmapped(report.unmapped.statuses, task.status);
  }

  let category = board.defaultCategory;
  if (task.type) {
    const mapped = mapping.types?.[task.type];
    const found = (mapped && board.categories.includes(mapped) ? mapped : undefined) ?? byName(board.categories, task.type);
    if (found) category = found;
    else noteUnmapped(report.unmapped.types, task.type);
  }

  let priority: Priority = "medium";
  if (task.priority) {
    const found = byName(PRIORITIES, task.priority);
    if (found) priority = found;
    else report.dropped.push({ id: task.id, field: "priority", value: shown(task.priority), reason: "not low, medium, high or urgent" });
  }

  let assignee: Types.ObjectId | null = null;
  if (task.assignee) {
    assignee = users.get(task.assignee) ?? null;
    if (!assignee) noteUnmapped(report.unmapped.users, task.assignee);
  }

  const completedAt = instant(report, task.id, "completedAt", task.completedAt);
  const createdAt = instant(report, task.id, "createdAt", task.createdAt);
  if (completedAt && board.columns.find((c) => c.id === status)?.role !== "done") {
    report.dropped.push({ id: task.id, field: "completedAt", value: shown(task.completedAt), reason: "the task is not in a done column" });
  }

  for (const relation of [task.parent ? "parent" : null, task.blockedBy?.length ? "blocked by" : null]) {
    if (relation) report.notImported.push({ id: task.id, what: relation });
  }

  return {
    ref: task.id,
    title,
    description: clip(report, task.id, "description", task.description ?? "", TASK_DESCRIPTION_MAX_LENGTH),
    status,
    category,
    priority,
    assignee,
    createdAt,
    completedAt: board.columns.find((c) => c.id === status)?.role === "done" ? completedAt : null,
    customFieldValues: resolveFields(report, task, board),
    comments: (task.comments ?? []).flatMap((comment) => resolveComment(report, task.id, comment, users, importer)),
  };
}

function resolveComment(
  report: ImportReport,
  taskId: string,
  comment: ImportComment,
  users: Map<string, Types.ObjectId | null>,
  importer: Types.ObjectId
): Resolved["comments"] {
  const author = comment.author ? users.get(comment.author) ?? null : null;
  const createdAt = instant(report, `${taskId}#${comment.id}`, "createdAt", comment.createdAt);
  // When the writer has no account here, their name stays in the text rather than being lost
  const byline = author ? "" : `*Originally by ${stripControlCharacters(comment.author ?? "an unknown author").trim() || "an unknown author"}*\n\n`;
  const body = byline + clip(report, `${taskId}#${comment.id}`, "body", comment.body, COMMENT_BODY_MAX_LENGTH - byline.length);
  if (!body.trim()) return [];
  return [{ ref: comment.id, body, author: author ?? importer, createdAt }];
}

async function readBoard(db: ScopedDb, projectId: string): Promise<Board | null> {
  const project = await db.Project.findById(projectId, "columns categories customFields").lean();
  if (!project) return null;
  const categories = (project.categories ?? []).map((c: { name: string }) => c.name);
  return {
    columns: getProjectColumns(project) as IProjectColumn[],
    categories,
    fields: activeFields(normalizeFields(project.customFields as unknown[])),
    defaultStatus: defaultStatusFor(project),
    defaultCategory: categories.includes("user-story") ? "user-story" : (categories[0] ?? "user-story"),
  };
}

const emptyReport = (dryRun: boolean, bundle: ImportBundle): ImportReport => ({
  dryRun,
  source: bundle.source,
  total: bundle.tasks.length,
  created: 0,
  updated: 0,
  comments: { created: 0, updated: 0 },
  skipped: [],
  dropped: [],
  truncated: [],
  unmapped: { statuses: [], users: [], types: [] },
  notImported: [],
  processed: 0,
  complete: false,
});

async function writeChunk(
  db: ScopedDb,
  projectId: string,
  source: string,
  importer: Types.ObjectId,
  chunk: Resolved[],
  report: ImportReport,
  createdIn: string
): Promise<void> {
  const existing = await db.Task.find({ project: projectId, "externalRef.source": source, "externalRef.id": { $in: chunk.map((t) => t.ref) } })
    .select("_id externalRef")
    .lean<{ _id: Types.ObjectId; externalRef: { id: string } }[]>();
  const known = new Map(existing.map((t) => [t.externalRef.id, t._id]));
  const fresh = chunk.filter((t) => !known.has(t.ref));
  const now = new Date();

  if (fresh.length > 0) {
    const project = await db.Project.findOneAndUpdate({ _id: projectId }, { $inc: { taskCounter: fresh.length } }, { returnDocument: "after" }).lean<{ taskCounter: number }>();
    if (!project) throw new Error("The project is gone");
    const first = project.taskCounter - fresh.length + 1;
    const docs = fresh.map((t, i) => {
      const _id = new Types.ObjectId();
      known.set(t.ref, _id);
      const createdAt = t.createdAt ?? now;
      return {
        _id,
        project: projectId,
        taskNumber: first + i,
        title: t.title,
        description: t.description,
        status: t.status,
        category: t.category,
        priority: t.priority,
        assignee: t.assignee,
        assignedBy: t.assignee ? importer : null,
        customFieldValues: t.customFieldValues,
        externalRef: { source, id: t.ref },
        createdBy: importer,
        createdAt,
        updatedAt: t.completedAt ?? createdAt,
      };
    });
    await db.Task.insertMany(docs);
    await logActivities(
      db,
      fresh.flatMap((t) => [
        { projectId, taskId: known.get(t.ref)!, userId: importer, action: "created" as const, at: t.createdAt ?? now },
        // Insights reads a finish from the move into a done column, so a finished task gets one
        ...(t.completedAt
          ? [{ projectId, taskId: known.get(t.ref)!, userId: importer, action: "status_changed" as const, field: "status", oldValue: createdIn, newValue: t.status, at: t.completedAt }]
          : []),
      ])
    );
    report.created += fresh.length;
  }

  const again = chunk.filter((t) => !fresh.includes(t));
  if (again.length > 0) {
    await db.Task.bulkWrite(
      again.map((t) => ({
        updateOne: {
          filter: { _id: known.get(t.ref) },
          update: {
            $set: {
              title: t.title,
              description: t.description,
              status: t.status,
              category: t.category,
              priority: t.priority,
              assignee: t.assignee,
              ...Object.fromEntries(Object.entries(t.customFieldValues).map(([k, v]) => [`customFieldValues.${k}`, v])),
            },
          },
        },
      }))
    );
    report.updated += again.length;
  }

  for (const t of chunk) {
    if (t.comments.length === 0) continue;
    const taskId = known.get(t.ref)!;
    const stored = await db.Comment.find({ task: taskId, "externalRef.source": source, "externalRef.id": { $in: t.comments.map((c) => c.ref) } })
      .select("_id externalRef")
      .lean<{ _id: Types.ObjectId; externalRef: { id: string } }[]>();
    const storedIds = new Map(stored.map((c) => [c.externalRef.id, c._id]));
    const newComments = t.comments.filter((c) => !storedIds.has(c.ref));
    if (newComments.length) {
      await db.Comment.insertMany(
        newComments.map((c) => ({
          task: taskId,
          author: c.author,
          body: c.body,
          reactions: [],
          externalRef: { source, id: c.ref },
          source: "import",
          sourceDetail: source,
          createdAt: c.createdAt ?? now,
          updatedAt: c.createdAt ?? now,
        }))
      );
    }
    const changed = t.comments.filter((c) => storedIds.has(c.ref));
    if (changed.length) {
      await db.Comment.bulkWrite(changed.map((c) => ({ updateOne: { filter: { _id: storedIds.get(c.ref) }, update: { $set: { body: c.body } } } })));
    }
    report.comments.created += newComments.length;
    report.comments.updated += changed.length;
  }
  report.processed += chunk.length;
}

/**
 * The quiet path: no notifications, no webhooks, no board feed, one audit row for the whole run.
 * Everything that could not be carried over is said in the report, and a dry run returns the same
 * report having written nothing.
 */
export async function runImport(
  db: ScopedDb,
  projectId: string,
  importer: Types.ObjectId,
  bundle: ImportBundle,
  mapping: ImportMapping,
  { dryRun }: { dryRun: boolean }
): Promise<ImportReport> {
  const report = emptyReport(dryRun, bundle);
  const board = await readBoard(db, projectId);
  if (!board) return { ...report, error: "Project not found" };

  const users = await resolveUsers(db, projectId, bundle, mapping);
  const resolved = bundle.tasks.flatMap((task) => {
    const r = resolveTask(report, task, board, mapping, users, importer);
    return r ? [r] : [];
  });
  if (dryRun) {
    report.created = resolved.length;
    report.comments.created = resolved.reduce((n, t) => n + t.comments.length, 0);
    const existing = await db.Task.countDocuments({ project: projectId, "externalRef.source": bundle.source, "externalRef.id": { $in: resolved.map((t) => t.ref) } });
    report.updated = existing;
    report.created -= existing;
    report.processed = resolved.length;
    report.complete = true;
    return report;
  }

  await actingThrough({ source: "import", detail: bundle.source }, async () => {
    try {
      for (let i = 0; i < resolved.length; i += IMPORT_CHUNK) {
        await writeChunk(db, projectId, bundle.source, importer, resolved.slice(i, i + IMPORT_CHUNK), report, board.defaultStatus);
      }
      report.complete = true;
    } catch (err) {
      report.error = err instanceof Error ? err.message : "The import stopped";
    }
  });

  await logProjectAudit(db, projectId, importer, "tasks_imported", [
    `From ${bundle.source}: ${report.created} created, ${report.updated} updated, ${report.skipped.length} skipped`,
    ...(report.complete ? [] : [`Stopped after ${report.processed} of ${resolved.length}: ${report.error}`]),
  ]);
  return report;
}

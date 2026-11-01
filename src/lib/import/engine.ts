import { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import type { IChecklistItem, ICustomField, IProjectColumn, Priority } from "@/types";
import { defaultStatusFor, getProjectColumns } from "@/lib/columns";
import { activeFields, matchOptionValue, normalizeFields, validateCustomFieldValues } from "@/lib/custom-fields";
import { recipientsWithAccess } from "@/lib/grants";
import {
  COMMENT_BODY_MAX_LENGTH,
  CRITERION_TEXT_MAX_LENGTH,
  MAX_CHECKLIST_ITEMS,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  isControlCodePoint,
  rendersBlank,
  stripControlCharacters,
} from "@/lib/identifiers";
import { matchCriteria } from "@/lib/checklist";
import { logActivities } from "@/lib/activity";
import { actingThrough } from "@/lib/activity-source";
import { logProjectAudit } from "@/lib/projectAudit";
import type { ImportBundle, ImportComment, ImportMapping, ImportTask } from "./bundle";
import { normaliseInstant } from "./dates";
import { linkImported } from "./links";

export const IMPORT_CHUNK = 200;
const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "urgent"];
const NO_PRIORITY = new Set(["no priority", "none", "-"]);
// The scales other trackers ship with: Jira's current and classic ones, and Linear's
const PRIORITY_NAMES: Record<string, Priority> = {
  highest: "urgent", blocker: "urgent", critical: "urgent",
  major: "high",
  normal: "medium",
  immediate: "urgent",
  lowest: "low", minor: "low", trivial: "low",
  najwyższy: "urgent", krytyczny: "urgent", blokujący: "urgent", poważny: "high", drobny: "low", trywialny: "low", wysoki: "high", średni: "medium", normalny: "medium", niski: "low", najniższy: "low",
};

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
  links: number;
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
  dueDate: Date | null;
  given: { status: boolean; description: boolean; category: boolean; priority: boolean };
  customFieldValues: Record<string, unknown>;
  comments: { ref: string; body: string; author: Types.ObjectId; createdAt: Date | null }[];
  checklist: { text: string; done: boolean }[];
  order: number;
  finishNote?: ImportReport["notImported"][number];
}

const shown = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

function keepLines(text: string): string {
  let out = "";
  for (const character of text.replace(/\r\n?/g, "\n")) {
    if (character === "\n" || character === "\t" || !isControlCodePoint(character.codePointAt(0) ?? 0)) out += character;
  }
  return out;
}

function clip(report: ImportReport, id: string, field: string, text: string, max: number, { lines = false } = {}): string {
  const clean = (lines ? keepLines(text) : stripControlCharacters(text.replace(/\s*[\r\n]+\s*/g, " "))).trim();
  if (clean.length <= max) return clean;
  report.truncated.push({ id, field });
  return clean.slice(0, max);
}

function instant(report: ImportReport, id: string, field: string, raw: string | undefined): Date | null {
  if (!raw) return null;
  // A time with no zone is read as UTC, so the same file means the same instant on every server
  const at = new Date(normaliseInstant(raw));
  if (!isCalendarDay(raw.slice(0, 10)) || Number.isNaN(at.getTime()) || at.getTime() > Date.now()) {
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

function isCalendarDay(text: string): boolean {
  const at = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === text;
}

function calendarDay(report: ImportReport, id: string, raw: string | undefined): Date | null {
  if (!raw) return null;
  if (!isCalendarDay(raw)) {
    report.dropped.push({ id, field: "dueDate", value: shown(raw), reason: "not a day, YYYY-MM-DD" });
    return null;
  }
  return new Date(`${raw}T00:00:00.000Z`);
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
    if (field.fieldType === "multiselect" && Array.isArray(raw)) {
      // Labels are free-form in most trackers: the ones this board offers come across, each other one is listed
      const known: string[] = [];
      for (const v of raw) {
        const id = matchOptionValue(field, v);
        if (id) known.push(id);
        else report.dropped.push({ id: task.id, field: field.name, value: shown(v), reason: `${field.name} has no such option` });
      }
      if (known.length === 0) continue;
      value = [...new Set(known)];
    }
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
    ? await db.User.find({ $or: [{ username: { $in: usernames } }, { email: { $in: usernames } }], deactivatedAt: null })
        .select("_id username email")
        .lean<{ _id: Types.ObjectId; username: string; email?: string }[]>()
    : [];
  const members = new Set(await recipientsWithAccess(db, accounts.map((a) => String(a._id)), projectId));
  const reachable = accounts.filter((a) => members.has(String(a._id)));
  const byUsername = new Map(reachable.map((a) => [a.username, a._id]));
  const byEmail = new Map(reachable.filter((a) => a.email).map((a) => [a.email!, a._id]));
  return new Map(
    [...wanted].map(([name, wantedName]) => [name, wantedName ? (byUsername.get(wantedName) ?? byEmail.get(wantedName) ?? null) : null])
  );
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
  const finishesIn = task.finished === true && task.status ? board.columns.find((c) => c.role === "done") : undefined;
  let finishNote: ImportReport["notImported"][number] | undefined;
  let status = board.defaultStatus;
  let statusGiven = false;
  if (task.status) {
    const mapped = mapping.statuses?.[task.status];
    const found =
      (mapped && columnIds.includes(mapped) ? mapped : undefined) ??
      byName(columnIds, task.status) ??
      board.columns.find((c) => c.label.trim().toLowerCase() === task.status!.trim().toLowerCase())?.id;
    if (found) [status, statusGiven] = [found, true];
    else if (!finishesIn) noteUnmapped(report.unmapped.statuses, task.status);
  }
  if (finishesIn && board.columns.find((c) => c.id === status)?.role !== "done") {
    finishNote = { id: title, what: `its status “${shown(task.status!)}”: it is finished, so it goes to ${finishesIn.label}` };
    report.notImported.push(finishNote);
    [status, statusGiven] = [finishesIn.id, true];
  }

  let category = board.defaultCategory;
  let categoryGiven = false;
  if (task.type) {
    const mapped = mapping.types?.[task.type];
    const found = (mapped && board.categories.includes(mapped) ? mapped : undefined) ?? byName(board.categories, task.type);
    if (found) [category, categoryGiven] = [found, true];
    else noteUnmapped(report.unmapped.types, task.type);
  }

  let priority: Priority = "medium";
  let priorityGiven = false;
  if (task.priority && !NO_PRIORITY.has(task.priority.trim().toLowerCase())) {
    const found = byName(PRIORITIES, task.priority) ?? PRIORITY_NAMES[task.priority.trim().toLowerCase()];
    if (found) [priority, priorityGiven] = [found, true];
    else report.dropped.push({ id: task.id, field: "priority", value: shown(task.priority), reason: "not low, medium, high or urgent" });
  }

  let assignee: Types.ObjectId | null = null;
  if (task.assignee) {
    assignee = users.get(task.assignee) ?? null;
    const leftUnassigned = mapping.users?.[task.assignee] === null && Object.hasOwn(mapping.users, task.assignee);
    if (!assignee && !leftUnassigned) noteUnmapped(report.unmapped.users, task.assignee);
  }

  const createdAt = instant(report, task.id, "createdAt", task.createdAt);
  let completedAt = instant(report, task.id, "completedAt", task.completedAt);
  // A finish with nothing to measure it from would count in Insights as a lead time of zero
  const finishRefusal =
    completedAt && board.columns.find((c) => c.id === status)?.role !== "done"
      ? "the task is not in a done column"
      : completedAt && !createdAt
        ? "the task has no creation time to measure it from"
        : completedAt && createdAt && completedAt < createdAt
          ? "it is before the task was created"
          : null;
  if (finishRefusal) {
    report.dropped.push({ id: task.id, field: "completedAt", value: shown(task.completedAt), reason: finishRefusal });
    completedAt = null;
  }

  return {
    ref: task.id,
    title,
    description: clip(report, task.id, "description", task.description ?? "", TASK_DESCRIPTION_MAX_LENGTH, { lines: true }),
    status,
    category,
    priority,
    assignee,
    createdAt,
    completedAt,
    dueDate: calendarDay(report, task.id, task.dueDate),
    given: { status: statusGiven, description: task.description !== undefined && task.description !== null, category: categoryGiven, priority: priorityGiven },
    customFieldValues: resolveFields(report, task, board),
    comments: (task.comments ?? []).flatMap((comment) => resolveComment(report, task.id, comment, users, importer)),
    checklist: resolveChecklist(report, task),
    order: task.order ?? 0,
    finishNote,
  };
}

function resolveChecklist(report: ImportReport, task: ImportTask): Resolved["checklist"] {
  const items = (task.checklist ?? []).flatMap((item) => {
    const text = clip(report, task.id, "checklist", item.text, CRITERION_TEXT_MAX_LENGTH);
    return rendersBlank(text) ? [] : [{ text, done: item.done === true }];
  });
  if (items.length <= MAX_CHECKLIST_ITEMS) return items;
  report.truncated.push({ id: task.id, field: "checklist" });
  return items.slice(0, MAX_CHECKLIST_ITEMS);
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
  const body = byline + clip(report, `${taskId}#${comment.id}`, "body", comment.body, COMMENT_BODY_MAX_LENGTH - byline.length, { lines: true });
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
  notImported: [...(bundle.notes ?? [])],
  links: 0,
  processed: 0,
  complete: false,
});

interface Stored {
  _id: Types.ObjectId;
  status: string;
  held: boolean;
  checklist: IChecklistItem[];
}

async function storedTasks(db: ScopedDb, projectId: string, source: string, refs: string[]): Promise<Map<string, Stored>> {
  const rows = await db.Task.find({ project: projectId, "externalRef.source": source, "externalRef.id": { $in: refs } })
    .select("_id status externalRef execution.runId checklist")
    .lean<{ _id: Types.ObjectId; status: string; externalRef: { id: string }; execution?: { runId?: string }; checklist?: IChecklistItem[] }[]>();
  return new Map(rows.map((t) => [t.externalRef.id, { _id: t._id, status: t.status, held: !!t.execution?.runId, checklist: t.checklist ?? [] }]));
}

// A criterion the file also has keeps its id and takes the file's tick; one only the board has stays
function mergedChecklist(report: ImportReport, t: Resolved, held: IChecklistItem[]): IChecklistItem[] {
  const markdown = t.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n");
  const { merged, unmatched } = matchCriteria(markdown, held);
  const all = [...merged, ...unmatched] as IChecklistItem[];
  const cut = Math.max(0, all.length - MAX_CHECKLIST_ITEMS);
  const stayed = unmatched.length - cut;
  if (stayed > 0) report.notImported.push({ id: t.title, what: `${stayed} ${stayed === 1 ? "criterion" : "criteria"} on the task that the file does not have, left in place` });
  if (cut > 0) report.notImported.push({ id: t.title, what: `${cut} ${cut === 1 ? "criterion" : "criteria"} removed from the task, as it holds ${MAX_CHECKLIST_ITEMS} and the file comes first` });
  return all.slice(0, MAX_CHECKLIST_ITEMS);
}

// A run's task refuses to leave its column through every writer, an import included
function noteHeld(report: ImportReport, t: Resolved, stored: Stored) {
  if (!t.given.status || !stored.held || stored.status === t.status) return;
  report.notImported = report.notImported.filter((n) => n !== t.finishNote);
  report.notImported.push({ id: t.ref, what: "its column: a machine is running it" });
}

async function storedComments(db: ScopedDb, source: string, taskIds: Types.ObjectId[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await db.Comment.find({ task: { $in: taskIds }, "externalRef.source": source })
    .select("task externalRef")
    .lean<{ task: Types.ObjectId; externalRef: { id: string } }[]>();
  return new Set(rows.map((c) => `${c.task}:${c.externalRef.id}`));
}

const DUPLICATE_KEY = 11000;

function stoppedBecause(err: unknown): Error {
  if ((err as { code?: number })?.code === DUPLICATE_KEY) {
    return new Error("another import of the same tasks ran at the same time");
  }
  return err instanceof Error ? err : new Error("The import stopped");
}

async function writeChunk(
  db: ScopedDb,
  projectId: string,
  source: string,
  importer: Types.ObjectId,
  chunk: Resolved[],
  report: ImportReport,
  createdIn: string
): Promise<void> {
  const stored = await storedTasks(db, projectId, source, chunk.map((t) => t.ref));
  const known = new Map([...stored].map(([ref, t]) => [ref, t._id]));
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
        dueDate: t.dueDate,
        checklist: t.checklist,
        order: t.order,
        customFieldValues: t.customFieldValues,
        externalRef: { source, id: t.ref },
        createdBy: importer,
        createdAt,
        updatedAt: t.completedAt ?? createdAt,
      };
    });
    let written = fresh;
    let failure: Error | null = null;
    try {
      await db.Task.insertMany(docs);
    } catch (err) {
      // An ordered insert keeps what it wrote before the failure; those still get their history
      failure = stoppedBecause(err);
      const landed = await storedTasks(db, projectId, source, fresh.map((t) => t.ref));
      written = fresh.filter((t) => landed.get(t.ref)?._id.equals(known.get(t.ref)!));
    }
    await logActivities(
      db,
      written.flatMap((t) => [
        { projectId, taskId: known.get(t.ref)!, userId: importer, action: "created" as const, at: t.createdAt ?? now },
        // Insights reads a finish from the move into a done column, so a finished task gets one
        ...(t.completedAt
          ? [{ projectId, taskId: known.get(t.ref)!, userId: importer, action: "status_changed" as const, field: "status", oldValue: createdIn, newValue: t.status, at: t.completedAt }]
          : []),
      ])
    );
    report.created += written.length;
    if (failure) {
      report.processed += written.length;
      throw failure;
    }
  }

  const again = chunk.filter((t) => !fresh.includes(t));
  if (again.length > 0) {
    const moves: Parameters<typeof logActivities>[1] = [];
    await db.Task.bulkWrite(
      again.map((t) => {
        const before = stored.get(t.ref)!;
        noteHeld(report, t, before);
        // Dated now, not at the source's finish: the board may have moved it since the last import
        const moved = t.given.status && !before.held && before.status !== t.status;
        if (moved) {
          moves.push({ projectId, taskId: before._id, userId: importer, action: "status_changed", field: "status", oldValue: before.status, newValue: t.status, at: now });
        }
        return {
          updateOne: {
            filter: { _id: before._id },
            update: {
              $set: {
                title: t.title,
                // What the file does not carry stays as the board has it
                ...(t.given.description && { description: t.description }),
                ...(t.given.category && { category: t.category }),
                ...(t.given.priority && { priority: t.priority }),
                // An import never unassigns: somebody it cannot name is left as the board has it
                ...(t.assignee && { assignee: t.assignee, assignedBy: importer }),
                ...(t.dueDate && { dueDate: t.dueDate }),
                ...(t.checklist.length > 0 && { checklist: mergedChecklist(report, t, before.checklist) }),
                ...(moved && { status: t.status }),
                ...Object.fromEntries(Object.entries(t.customFieldValues).map(([k, v]) => [`customFieldValues.${k}`, v])),
              },
            },
          },
        };
      })
    );
    await logActivities(db, moves);
    report.updated += again.length;
  }

  for (const t of chunk) {
    if (t.comments.length === 0) continue;
    const taskId = known.get(t.ref)!;
    const prior = await db.Comment.find({ task: taskId, "externalRef.source": source, "externalRef.id": { $in: t.comments.map((c) => c.ref) } })
      .select("_id externalRef")
      .lean<{ _id: Types.ObjectId; externalRef: { id: string } }[]>();
    const storedIds = new Map(prior.map((c) => [c.externalRef.id, c._id]));
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

async function carryLinks(
  db: ScopedDb,
  projectId: string,
  importer: Types.ObjectId,
  bundle: ImportBundle,
  resolved: Resolved[],
  report: ImportReport,
  opts: { dryRun: boolean; pending: Set<string> }
) {
  const kept = new Set(resolved.map((t) => t.ref));
  // A task of this file that has no task on the board to link: skipped, or after a stop never written
  const absent = new Map<string, string>();
  for (const s of report.skipped) absent.set(s.id, `was skipped: ${s.reason}`);
  if (!opts.dryRun && !report.complete) for (const t of resolved) absent.set(t.ref, "was not imported: the import stopped");
  const outcome = await linkImported(db, projectId, importer, bundle.source, bundle.tasks.filter((t) => kept.has(t.id)), { ...opts, absent });
  report.links = outcome.created;
  report.notImported.push(...outcome.unlinked);
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
    const stored = await storedTasks(db, projectId, bundle.source, resolved.map((t) => t.ref));
    const comments = await storedComments(db, bundle.source, [...stored.values()].map((t) => t._id));
    for (const t of resolved) {
      const before = stored.get(t.ref);
      if (before) noteHeld(report, t, before);
      if (before && t.checklist.length > 0) mergedChecklist(report, t, before.checklist);
      for (const c of t.comments) {
        if (before && comments.has(`${before._id}:${c.ref}`)) report.comments.updated += 1;
        else report.comments.created += 1;
      }
    }
    report.updated = stored.size;
    report.created = resolved.length - stored.size;
    report.processed = resolved.length;
    const pending = new Set(resolved.map((t) => t.ref).filter((ref) => !stored.has(ref)));
    await carryLinks(db, projectId, importer, bundle, resolved, report, { dryRun: true, pending });
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
      report.error = stoppedBecause(err).message;
    }
    // What was written is linked even when the run stopped part-way; the rest is listed
    try {
      await carryLinks(db, projectId, importer, bundle, resolved, report, { dryRun: false, pending: new Set() });
    } catch (err) {
      report.error ??= `the links between tasks were not made: ${stoppedBecause(err).message}`;
      report.complete = false;
    }
  });

  await logProjectAudit(db, projectId, importer, "tasks_imported", [
    `From ${bundle.source}: ${report.created} created, ${report.updated} updated, ${report.skipped.length} skipped`,
    ...(report.complete ? [] : [`Stopped after ${report.processed} of ${resolved.length}: ${report.error}`]),
  ]);
  return report;
}

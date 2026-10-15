import { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { logActivities } from "@/lib/activity";
import { taskKeyOf } from "@/lib/task-key";
import type { ImportTask } from "./bundle";

export interface LinkOutcome {
  created: number;
  unlinked: { id: string; what: string }[];
}

interface Stored {
  _id: Types.ObjectId;
  taskNumber: number;
  relations?: { task: Types.ObjectId; type: string }[];
  blockedBy?: Types.ObjectId[];
}

type Pair = { kind: "parent"; parent: string; child: string } | { kind: "blocked"; blocked: string; blocker: string };

const shownRef = (ref: string) => `“${ref.length > 60 ? `${ref.slice(0, 60)}…` : ref}”`;

/**
 * A task's parent and its blockers, made into the same links a person makes on the board. A reference
 * resolves to a task of this import or of an earlier one from the same source. Nothing is ever removed:
 * a child the board already gave another parent keeps it, and a link that would close a loop is not
 * made. Each of those is listed instead, and so is a reference that names no task at all.
 */
export async function linkImported(
  db: ScopedDb,
  projectId: string,
  importer: Types.ObjectId,
  source: string,
  tasks: ImportTask[],
  { dryRun, pending, absent = new Map() }: { dryRun: boolean; pending: Set<string>; absent?: Map<string, string> }
): Promise<LinkOutcome> {
  const outcome: LinkOutcome = { created: 0, unlinked: [] };
  const pairs: Pair[] = [];
  for (const t of tasks) {
    if (t.parent) pairs.push({ kind: "parent", parent: t.parent, child: t.id });
    for (const b of new Set(t.blockedBy ?? [])) pairs.push({ kind: "blocked", blocked: t.id, blocker: b });
  }
  if (pairs.length === 0) return outcome;

  const refs = [...new Set(pairs.flatMap((p) => (p.kind === "parent" ? [p.parent, p.child] : [p.blocked, p.blocker])))];
  const found = await db.Task.find({ project: projectId, "externalRef.source": source, "externalRef.id": { $in: refs } })
    .select("_id externalRef")
    .lean<{ _id: Types.ObjectId; externalRef: { id: string } }[]>();
  const idOf = new Map(found.map((t) => [t.externalRef.id, String(t._id)]));
  // A dry run writes nothing, so a task this file would create stands in under a made-up id
  const madeUp = new Set<string>();
  for (const ref of pending) {
    if (idOf.has(ref)) continue;
    const id = new Types.ObjectId().toString();
    idOf.set(ref, id);
    madeUp.add(id);
  }

  const project = await db.Project.findById(projectId, "key").lean<{ key?: string }>();
  const board = await db.Task.find(
    { project: projectId, $or: [{ "relations.0": { $exists: true } }, { "blockedBy.0": { $exists: true } }, { _id: { $in: [...idOf.values()].filter((id) => !madeUp.has(id)) } }] },
    "_id taskNumber relations blockedBy"
  ).lean<Stored[]>();
  const byId = new Map(board.map((t) => [String(t._id), t]));

  const children = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>();
  const blockersOf = new Map<string, Set<string>>();
  const pairType = new Map<string, string>();
  for (const t of board) {
    for (const r of t.relations ?? []) {
      pairType.set(`${t._id}>${r.task}`, r.type);
      if (r.type !== "parent_of") continue;
      if (!children.has(String(t._id))) children.set(String(t._id), new Set());
      children.get(String(t._id))!.add(String(r.task));
      parentOf.set(String(r.task), String(t._id));
    }
    blockersOf.set(String(t._id), new Set((t.blockedBy ?? []).map(String)));
  }

  const reaches = (from: string, to: string, next: (id: string) => Iterable<string>) => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...next(current));
    }
    return false;
  };

  const parents: { parent: string; child: string }[] = [];
  const blocked: { blocked: string; blocker: string }[] = [];
  for (const pair of pairs) {
    const [holderRef, otherRef] = pair.kind === "parent" ? [pair.child, pair.parent] : [pair.blocked, pair.blocker];
    const holder = idOf.get(holderRef);
    const other = idOf.get(otherRef);
    const what = pair.kind === "parent" ? "parent" : "blocked by";
    if (!holder) {
      outcome.unlinked.push({ id: holderRef, what: `${what} ${shownRef(otherRef)}: this task ${absent.get(holderRef) ?? "is not on the board"}` });
      continue;
    }
    if (!other) {
      const why = absent.has(otherRef) ? `that task ${absent.get(otherRef)}` : "no such task in this file or an earlier import";
      outcome.unlinked.push({ id: holderRef, what: `${what} ${shownRef(otherRef)}: ${why}` });
      continue;
    }
    if (holder === other) {
      outcome.unlinked.push({ id: holderRef, what: `${what}: names the task itself` });
      continue;
    }
    if (pair.kind === "parent") {
      const current = parentOf.get(holder);
      if (current === other) continue;
      if (current) {
        outcome.unlinked.push({ id: holderRef, what: `parent ${shownRef(otherRef)}: it already has another parent on the board` });
        continue;
      }
      if (pairType.has(`${other}>${holder}`)) {
        outcome.unlinked.push({ id: holderRef, what: `parent ${shownRef(otherRef)}: the two are already linked another way` });
        continue;
      }
      if (reaches(holder, other, (id) => children.get(id) ?? [])) {
        outcome.unlinked.push({ id: holderRef, what: `parent ${shownRef(otherRef)}: it would be its own ancestor` });
        continue;
      }
      parentOf.set(holder, other);
      if (!children.has(other)) children.set(other, new Set());
      children.get(other)!.add(holder);
      pairType.set(`${other}>${holder}`, "parent_of");
      parents.push({ parent: other, child: holder });
    } else {
      const mine = blockersOf.get(holder) ?? new Set<string>();
      if (mine.has(other)) continue;
      if (reaches(other, holder, (id) => blockersOf.get(id) ?? [])) {
        outcome.unlinked.push({ id: holderRef, what: `blocked by ${shownRef(otherRef)}: the two would block each other` });
        continue;
      }
      mine.add(other);
      blockersOf.set(holder, mine);
      blocked.push({ blocked: holder, blocker: other });
    }
  }
  outcome.created = parents.length + blocked.length;
  if (dryRun || outcome.created === 0) return outcome;

  await db.Task.bulkWrite([
    ...parents.map((p) => ({
      updateOne: {
        // A parent the board gave this child in the meantime is not doubled
        filter: { _id: p.parent, project: projectId, "relations.task": { $ne: new Types.ObjectId(p.child) } },
        update: { $push: { relations: { task: new Types.ObjectId(p.child), type: "parent_of" as const } } },
      },
    })),
    ...blocked.map((b) => ({
      updateOne: {
        filter: { _id: b.blocked, project: projectId },
        update: { $addToSet: { blockedBy: new Types.ObjectId(b.blocker) } },
      },
    })),
  ]);

  // Counted and written into History from what the board holds now, not from the plan: a task deleted
  // in between, or a link that did not land, is not announced
  const after = await db.Task.find(
    { project: projectId, _id: { $in: [...new Set([...parents.flatMap((p) => [p.parent, p.child]), ...blocked.flatMap((b) => [b.blocked, b.blocker])])] } },
    "_id taskNumber relations blockedBy"
  ).lean<Stored[]>();
  const now = new Map(after.map((t) => [String(t._id), t]));
  const landedParents = parents.filter(
    (p) => now.has(p.child) && (now.get(p.parent)?.relations ?? []).some((r) => String(r.task) === p.child && r.type === "parent_of")
  );
  const landedBlocked = blocked.filter((b) => now.has(b.blocker) && (now.get(b.blocked)?.blockedBy ?? []).some((id) => String(id) === b.blocker));
  outcome.created = landedParents.length + landedBlocked.length;
  const numbers = new Map(after.map((t) => [String(t._id), t.taskNumber]));
  const key = (id: string) => taskKeyOf(project?.key, numbers.get(id) ?? byId.get(id)?.taskNumber ?? 0);
  const row = (taskId: string, field: string, other: string) => ({
    projectId,
    taskId: new Types.ObjectId(taskId),
    userId: importer,
    action: "link_added" as const,
    field,
    oldValue: "",
    newValue: key(other),
  });
  await logActivities(db, [
    ...landedParents.flatMap((p) => [row(p.parent, "parent_of", p.child), row(p.child, "child_of", p.parent)]),
    ...landedBlocked.flatMap((b) => [row(b.blocked, "blocked_by", b.blocker), row(b.blocker, "blocks", b.blocked)]),
  ]);
  return outcome;
}

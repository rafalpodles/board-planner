import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import { createNotifications, collectRecipients, assigneeIdOf } from "@/lib/in-app-notifications";
import { describeLinkChange } from "@/lib/link-phrasing";
import { taskKeyOf } from "@/lib/task-key";
import { usernameOf } from "@/lib/usernames";
import { DependencyType, LinkDirection, RelationType } from "@/types";

export type LinkResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string; status: number };

/** Everything the announcing needs about one end of a link, in one projection. */
interface LinkEnd {
  _id: unknown;
  taskNumber: number;
  title: string;
  status: string;
  assignee?: unknown;
  watchers?: unknown[];
  relations?: { task: unknown; type: RelationType }[];
  blockedBy?: unknown[];
}

const END_FIELDS = "_id taskNumber title status assignee watchers relations blockedBy";

/**
 * One link that appeared or went away — a fact about a pair, not about a task. `holder` is the
 * task whose own document changed (relations are stored one-directionally), `target` the other
 * end. Both get a timeline row; the pair gets one webhook.
 */
interface LinkFact {
  action: "added" | "removed";
  type: DependencyType;
  holder: LinkEnd;
  target: LinkEnd;
}

const INVERSE: Record<DependencyType, LinkDirection> = {
  blocked_by: "blocks",
  relates: "relates",
  duplicates: "duplicated_by",
  parent_of: "child_of",
};

function idOf(value: unknown): string {
  return String((value as { _id?: unknown })?._id ?? value ?? "");
}

function relationBetween(task: LinkEnd, otherId: string): RelationType | undefined {
  return (task.relations ?? []).find((r) => idOf(r.task) === otherId)?.type;
}

function blocks(task: LinkEnd, otherId: string): boolean {
  return (task.blockedBy ?? []).some((id) => idOf(id) === otherId);
}

export async function addTaskLink(
  projectId: string,
  taskId: string,
  targetTaskId: string,
  type: DependencyType,
  actorId: string
): Promise<LinkResult> {
  if (targetTaskId === taskId) {
    return { ok: false, error: "A task cannot depend on itself", status: 400 };
  }

  const [task, other] = await Promise.all([
    Task.findOne({ _id: taskId, project: projectId }, END_FIELDS).lean<LinkEnd>(),
    Task.findOne({ _id: targetTaskId, project: projectId }, END_FIELDS).lean<LinkEnd>(),
  ]);

  if (!task || !other) {
    return { ok: false, error: "Task not found", status: 404 };
  }

  if (type === "blocked_by") {
    const cycle = await wouldCycle(projectId, taskId, targetTaskId);
    if (cycle) return cycle;

    if (blocks(task, targetTaskId)) return { ok: true, changed: false };

    await Task.findByIdAndUpdate(taskId, { $addToSet: { blockedBy: targetTaskId } });
    await announce(projectId, actorId, [
      { action: "added", type, holder: task, target: other },
    ]);
    return { ok: true, changed: true };
  }

  // A pair holds one relation, so choosing a different type replaces whatever was there — which
  // is a removal as much as an addition, and used to be the least visible write on the board.
  const replaced = relationBetween(task, targetTaskId);

  // `parent_of` is the one relation with a direction that must stay acyclic, and a task gets a
  // single parent so the hierarchy stays a tree.
  let losing: LinkEnd[] = [];
  if (type === "parent_of") {
    const cycle = await wouldDescend(projectId, taskId, targetTaskId);
    if (cycle) return cycle;

    // Read before the write: the previous parents are the tasks nobody named in this call, and
    // after `updateMany` there is nothing left to say who they were.
    const parents = await Task.find(
      { project: projectId, relations: { $elemMatch: { task: targetTaskId, type: "parent_of" } } },
      END_FIELDS
    ).lean<LinkEnd[]>();
    losing = parents.filter((p) => idOf(p) !== taskId);
  }

  if (replaced === type && losing.length === 0) return { ok: true, changed: false };

  if (type === "parent_of") {
    await Task.updateMany(
      { project: projectId, relations: { $elemMatch: { task: targetTaskId, type: "parent_of" } } },
      { $pull: { relations: { task: targetTaskId, type: "parent_of" } } }
    );
  }
  await Task.updateOne({ _id: taskId }, { $pull: { relations: { task: targetTaskId } } });
  await Task.updateOne(
    { _id: taskId },
    { $push: { relations: { task: targetTaskId, type: type as RelationType } } }
  );

  const facts: LinkFact[] = [];
  for (const parent of losing) {
    facts.push({ action: "removed", type: "parent_of", holder: parent, target: other });
  }
  if (replaced && replaced !== type) {
    facts.push({ action: "removed", type: replaced, holder: task, target: other });
  }
  facts.push({ action: "added", type, holder: task, target: other });

  await announce(projectId, actorId, facts);
  return { ok: true, changed: true };
}

export async function removeTaskLink(
  projectId: string,
  taskId: string,
  targetTaskId: string,
  type: DependencyType,
  actorId: string
): Promise<LinkResult> {
  const task = await Task.findOne({ _id: taskId, project: projectId }, END_FIELDS).lean<LinkEnd>();
  if (!task) return { ok: false, error: "Task not found", status: 404 };

  const held =
    type === "blocked_by" ? blocks(task, targetTaskId) : relationBetween(task, targetTaskId) === type;

  const update =
    type === "blocked_by"
      ? { $pull: { blockedBy: targetTaskId } }
      : { $pull: { relations: { task: targetTaskId, type } } };

  await Task.findOneAndUpdate({ _id: taskId, project: projectId }, update);

  // This end held no such link, so the write removed nothing. The request still answers 200 — the
  // route's contract is unchanged, and removal from the wrong end is BP-657's to settle — but a
  // history row, a bell and a webhook for a link that was never there would be worse than the
  // silence this ticket is about.
  if (!held) return { ok: true, changed: false };

  const other = await Task.findOne(
    { _id: targetTaskId, project: projectId },
    END_FIELDS
  ).lean<LinkEnd>();
  if (!other) return { ok: true, changed: true };

  await announce(projectId, actorId, [{ action: "removed", type, holder: task, target: other }]);
  return { ok: true, changed: true };
}

async function wouldCycle(
  projectId: string,
  taskId: string,
  targetTaskId: string
): Promise<LinkResult | null> {
  const all = await Task.find(
    { project: projectId, blockedBy: { $exists: true, $ne: [] } },
    "_id blockedBy"
  ).lean<{ _id: unknown; blockedBy: unknown[] }[]>();

  const dependents = new Map<string, string[]>();
  for (const t of all) {
    for (const blocker of t.blockedBy) {
      const key = idOf(blocker);
      if (!dependents.has(key)) dependents.set(key, []);
      dependents.get(key)!.push(idOf(t));
    }
  }

  const visited = new Set<string>();
  const queue = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetTaskId) {
      return {
        ok: false,
        error: "Circular dependency detected — this link would create a cycle",
        status: 400,
      };
    }
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of dependents.get(current) || []) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return null;
}

async function wouldDescend(
  projectId: string,
  taskId: string,
  targetTaskId: string
): Promise<LinkResult | null> {
  const parented = await Task.find(
    { project: projectId, "relations.type": "parent_of" },
    "_id relations"
  ).lean<{ _id: unknown; relations?: { task: unknown; type: RelationType }[] }[]>();

  const childrenOf = new Map<string, string[]>();
  for (const t of parented) {
    childrenOf.set(
      idOf(t),
      (t.relations || []).filter((r) => r.type === "parent_of").map((r) => idOf(r.task))
    );
  }

  const queue = [targetTaskId];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === taskId) {
      return { ok: false, error: "That would make the task its own descendant", status: 400 };
    }
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(childrenOf.get(current) || []));
  }
  return null;
}

/**
 * The trio every other write to a task already performs: a timeline row, a notification and a
 * webhook. Each fact writes a row at BOTH ends, because the relation is stored on one of them and
 * the other end's board changed just as much — the re-parented task's previous parent being the
 * case that was invisible to everybody, including the person who owned it.
 *
 * One notification per task, though, not per row. A re-parented child both loses and gains a
 * parent in the same write, and its bell should say what the task's situation IS — the gain —
 * rather than ring twice. The timeline keeps both halves.
 */
async function announce(projectId: string, actorId: string, facts: LinkFact[]): Promise<void> {
  if (facts.length === 0) return;

  const [project, actor] = await Promise.all([
    Project.findById(projectId, "key name").lean(),
    usernameOf(actorId),
  ]);
  const keyOf = (end: LinkEnd) => taskKeyOf(project?.key, end.taskNumber);

  const rows: { subject: LinkEnd; other: LinkEnd; direction: LinkDirection; fact: LinkFact }[] = [];
  for (const fact of facts) {
    rows.push({ subject: fact.holder, other: fact.target, direction: fact.type, fact });
    rows.push({ subject: fact.target, other: fact.holder, direction: INVERSE[fact.type], fact });
  }

  const sentence = (row: (typeof rows)[number], self: string) =>
    describeLinkChange({
      actor,
      action: row.fact.action,
      direction: row.direction,
      self,
      other: keyOf(row.other),
    });

  await Promise.all(
    rows.map((row) =>
      logActivity(
        idOf(row.subject),
        actorId,
        row.fact.action === "added" ? "link_added" : "link_removed",
        row.direction,
        row.fact.action === "added" ? "" : keyOf(row.other),
        row.fact.action === "added" ? keyOf(row.other) : ""
      )
    )
  );

  const perTask = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const id = idOf(row.subject);
    const held = perTask.get(id);
    if (!held || (held.fact.action === "removed" && row.fact.action === "added")) {
      perTask.set(id, row);
    }
  }

  for (const [id, row] of perTask) {
    const summary = sentence(row, keyOf(row.subject));
    createNotifications({
      type: "task_linked",
      taskId: id,
      projectId,
      actorId,
      title: summary,
      body: row.subject.title,
      recipientIds: collectRecipients(row.subject),
      email: {
        kicker: row.fact.action === "added" ? "Tasks linked" : "Link removed",
        taskKey: keyOf(row.subject),
        taskTitle: row.subject.title,
        taskMeta: [project?.name, summary].filter(Boolean).join(" · "),
        projectRef: project?.key,
        taskNumber: row.subject.taskNumber,
        assigneeId: assigneeIdOf(row.subject),
      },
    });
  }

  for (const fact of facts) {
    const event = fact.action === "added" ? "task_linked" : "task_unlinked";
    const payload = {
      project: { key: project?.key ?? "", name: project?.name ?? "" },
      task: { taskKey: keyOf(fact.holder), title: fact.holder.title, status: fact.holder.status },
      data: {
        type: fact.type,
        relatedTaskKey: keyOf(fact.target),
        relatedTaskTitle: fact.target.title,
        summary: describeLinkChange({
          actor,
          action: fact.action,
          direction: fact.type,
          self: keyOf(fact.holder),
          other: keyOf(fact.target),
        }),
      },
    };
    dispatchWebhooks(projectId, event, payload);
    dispatchNotifications(projectId, event, payload);
  }
}

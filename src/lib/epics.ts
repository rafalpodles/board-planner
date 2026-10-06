import { isValidObjectId } from "mongoose";
import { columnIdsWithRole } from "@/lib/columns";
import { tallyProgress } from "@/lib/epic-progress";
import { NOT_ARCHIVED } from "@/lib/task-archive";
import type { ApiEpicProgress } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";

type WithRelations = { _id: unknown; relations?: { type?: string; task?: unknown }[] };

const childIdsOf = (parent: WithRelations): string[] =>
  (parent.relations ?? []).filter((r) => r.type === "parent_of").map((r) => String(r.task));

/**
 * Progress of every task in `taskIds` that has children, read from the database for exactly those
 * tasks: the parents' links, then the statuses of their children, then the board's columns. A task
 * with no children is absent from the answer. "Done" is the column role, never the id `done`
 * (BP-446), so a board that renamed its columns still counts its finished work.
 */
export async function epicProgressFor(
  db: ScopedDb,
  projectId: string,
  taskIds: string[]
): Promise<Map<string, ApiEpicProgress>> {
  const progress = new Map<string, ApiEpicProgress>();
  if (taskIds.length === 0) return progress;

  const parents = (await db.Task.find(
    { project: projectId, _id: { $in: taskIds }, relations: { $elemMatch: { type: "parent_of" } } },
    "relations"
  ).lean()) as WithRelations[];
  if (parents.length === 0) return progress;

  const childIds = [...new Set(parents.flatMap(childIdsOf))];
  const [children, project] = await Promise.all([
    db.Task.find({ project: projectId, _id: { $in: childIds }, ...NOT_ARCHIVED }, "status").lean(),
    db.Project.findById(projectId, "columns").lean(),
  ]);
  const statusOf = new Map(children.map((c: { _id: unknown; status: string }) => [String(c._id), c.status]));
  const doneStatuses = columnIdsWithRole(project, "done");

  for (const parent of parents) {
    const statuses = childIdsOf(parent).flatMap((id) => (statusOf.has(id) ? [statusOf.get(id)!] : []));
    if (statuses.length > 0) progress.set(String(parent._id), tallyProgress(statuses, doneStatuses));
  }
  return progress;
}

export type EpicFilter = { parent?: string; hasChildren?: boolean };

/**
 * The query clauses behind "the children of this task" and "tasks that have children". Shared by
 * the tasks route and the PM agent, which reads Mongo itself and so cannot lean on the route.
 * `parent` is a task id; a refusal comes back as a message for the caller to word its own way.
 */
export async function epicClauses(
  db: ScopedDb,
  projectId: string,
  { parent, hasChildren }: EpicFilter
): Promise<{ clauses: Record<string, unknown>[] } | { error: string }> {
  const clauses: Record<string, unknown>[] = [];

  if (parent) {
    if (!isValidObjectId(parent)) return { error: "Invalid parent id" };
    const parentTask = await db.Task.findOne({ _id: parent, project: projectId }, "relations").lean();
    if (!parentTask) return { error: "Invalid parent — no such task on this board" };
    clauses.push({ _id: { $in: childIdsOf(parentTask as WithRelations) } });
  }

  if (hasChildren !== undefined) {
    clauses.push(
      hasChildren
        ? { relations: { $elemMatch: { type: "parent_of" } } }
        : { relations: { $not: { $elemMatch: { type: "parent_of" } } } }
    );
  }

  return { clauses };
}

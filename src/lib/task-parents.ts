import { Task } from "@/models/task";
import { ApiTaskLink, TaskStatus } from "@/types";

/**
 * A `parent_of` link is stored on the **parent's** document, so a child cannot name its own parent
 * from anything it holds. The detail route pays for that with a reverse lookup per task; the board
 * renders a column of children at once, so this does it once for the whole list.
 *
 * Scoped by project as well as by id: the ids come from a list the caller already resolved, but a
 * relation is only ever within one board and the index starts with `project`.
 */
export async function parentsOf(
  projectId: string,
  taskIds: string[]
): Promise<Map<string, ApiTaskLink>> {
  if (taskIds.length === 0) return new Map();

  const parents = await Task.find(
    {
      project: projectId,
      relations: { $elemMatch: { task: { $in: taskIds }, type: "parent_of" } },
    },
    "taskNumber title status relations"
  ).lean();

  const wanted = new Set(taskIds);
  const byChild = new Map<string, ApiTaskLink>();

  for (const parent of parents) {
    for (const relation of parent.relations ?? []) {
      // $elemMatch selected the document, not the entry: a parent of two tasks carries a relation
      // to each, and a parent that also `relates` to one of them carries that too
      if (relation.type !== "parent_of") continue;
      const child = String(relation.task);
      if (!wanted.has(child)) continue;
      byChild.set(child, {
        _id: String(parent._id),
        taskNumber: parent.taskNumber,
        title: parent.title,
        status: parent.status as TaskStatus,
      });
    }
  }

  return byChild;
}

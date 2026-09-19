import { Task } from "@/models/task";
import { ApiTaskLink, TaskStatus } from "@/types";

/**
 * A `parent_of` link is stored on the **parent's** document, so a child cannot name its own parent
 * from anything it holds.
 *
 * The board already derives the reverse side of a relation in the browser
 * (`withIncomingRelations`, `use-project-board.ts`) — but only across the tasks it loaded, and the
 * sprint scope narrows that to one sprint. An epic sitting in the backlog with its children in the
 * sprint is the ordinary shape here, and in that view the browser has nothing to derive from. So
 * the lookup runs on the server, over the whole project, and answers for a parent the caller
 * cannot see.
 *
 * Scoped by project as well as by id, which is also the index: `{ project: 1, "relations.task": 1 }`.
 */
export async function parentsOf(
  projectId: string,
  taskIds: string[]
): Promise<Map<string, ApiTaskLink>> {
  // The query no longer names the ids, so this is the only thing keeping an empty board from
  // asking anything at all
  if (taskIds.length === 0) return new Map();

  // Every parent on the board, not every document holding a relation to one of these ids: the
  // second shape needs one index bound per listed task and drags in `relates` and `duplicates`
  // too, since a type predicate on an array cannot be covered alongside one on its `task`. The ids
  // narrow the result in JS below, which is where the $in was doing its real work anyway.
  const parents = await Task.find(
    { project: projectId, "relations.type": "parent_of" },
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

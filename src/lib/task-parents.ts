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

  // Every parent on the board, not every document holding a relation to one of these ids. The ids
  // narrow the result in JS below, which is where the $in was doing its real work anyway.
  //
  // Measured on MongoDB 4.4 against a synthetic 3,000-task project, one index at a time:
  //
  //   unscoped board      no relations index          keys 3000  fetched 3000
  //                       {project, relations.task}   keys  299  fetched  204
  //                       {project, relations.type}   keys    5  fetched    5
  //
  // The 204 is the residual: a type predicate on an array cannot be covered alongside one on its
  // `task`, so the other relation kinds are fetched and discarded. The same index also serves the
  // cycle check in `links/route.ts`, which runs on every parent_of write and can use nothing else.
  //
  // The trade it makes, recorded because it is not free: keyed on the type this costs every parent
  // in the PROJECT, where keying on the child would cost only the parents of the visible tasks. On
  // a sprint-scoped view of 10 tasks that is 5 fetched against 3 with 5 parents about — and 500
  // against 4 with 500. It holds because parent_of here is the epic relation, so parents are tens;
  // a board that parented most of its tasks would want the other shape, and would find this
  // comment.
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

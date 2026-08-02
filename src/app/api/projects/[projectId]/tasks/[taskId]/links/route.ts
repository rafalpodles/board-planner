import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { DEPENDENCY_TYPES, DependencyType, RelationType } from "@/types";

// Add a dependency. "blocked_by" lands in blockedBy (the relation that drives
// cycle detection); the rest go into the typed relations array.
export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json();
  // blockedByTaskId is the pre-CP-143 field name, still accepted
  const targetTaskId: string | undefined = body.taskId || body.blockedByTaskId;
  const type: DependencyType = body.type || "blocked_by";

  if (!targetTaskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }
  if (!DEPENDENCY_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${DEPENDENCY_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  if (targetTaskId === taskId) {
    return NextResponse.json(
      { error: "A task cannot depend on itself" },
      { status: 400 }
    );
  }

  // Verify both tasks exist in the same project
  const [task, other] = await Promise.all([
    Task.findOne({ _id: taskId, project: projectId }),
    Task.findOne({ _id: targetTaskId, project: projectId }),
  ]);

  if (!task || !other) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // "parent_of" is the one relation with a direction that must stay acyclic,
  // and a task gets a single parent so the hierarchy stays a tree
  if (type === "parent_of") {
    const parented = await Task.find(
      { project: projectId, "relations.type": "parent_of" },
      "_id relations"
    ).lean();
    const childrenOf = new Map<string, string[]>();
    for (const t of parented) {
      childrenOf.set(
        t._id.toString(),
        (t.relations || [])
          .filter((r) => r.type === "parent_of")
          .map((r) => r.task.toString())
      );
    }
    const queue = [targetTaskId];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (current === taskId) {
        return NextResponse.json(
          { error: "That would make the task its own descendant" },
          { status: 400 }
        );
      }
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...(childrenOf.get(current) || []));
    }

    await Task.updateMany(
      { project: projectId, relations: { $elemMatch: { task: targetTaskId, type: "parent_of" } } },
      { $pull: { relations: { task: targetTaskId, type: "parent_of" } } }
    );
    await Task.updateOne({ _id: taskId }, { $pull: { relations: { task: targetTaskId } } });
    await Task.updateOne(
      { _id: taskId },
      { $push: { relations: { task: targetTaskId, type: "parent_of" } } }
    );
    return NextResponse.json({ message: "Dependency added" });
  }

  // Non-blocking kinds carry no ordering, so a cycle among them is meaningless.
  // One pair of tasks holds one relation, so picking a different type replaces it.
  if (type !== "blocked_by") {
    await Task.updateOne({ _id: taskId }, { $pull: { relations: { task: targetTaskId } } });
    await Task.updateOne(
      { _id: taskId },
      { $push: { relations: { task: targetTaskId, type: type as RelationType } } }
    );
    return NextResponse.json({ message: "Dependency added" });
  }

  // Check for circular dependency using in-memory BFS (single query)
  const allTasks = await Task.find(
    { project: projectId, blockedBy: { $exists: true, $ne: [] } },
    "_id blockedBy"
  ).lean();

  // Build reverse graph: task → tasks that depend on it
  const dependentsMap = new Map<string, string[]>();
  for (const t of allTasks) {
    for (const blocker of t.blockedBy) {
      const key = blocker.toString();
      if (!dependentsMap.has(key)) dependentsMap.set(key, []);
      dependentsMap.get(key)!.push(t._id.toString());
    }
  }

  const visited = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetTaskId) {
      return NextResponse.json(
        { error: "Circular dependency detected — this link would create a cycle" },
        { status: 400 }
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = dependentsMap.get(current) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  // Add if not already present
  await Task.findByIdAndUpdate(taskId, {
    $addToSet: { blockedBy: targetTaskId },
  });

  return NextResponse.json({ message: "Dependency added" });
});

// Remove a dependency of any kind
export const DELETE = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json();
  const targetTaskId: string | undefined = body.taskId || body.blockedByTaskId;
  const type: DependencyType = body.type || "blocked_by";

  if (!targetTaskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const update =
    type === "blocked_by"
      ? { $pull: { blockedBy: targetTaskId } }
      : { $pull: { relations: { task: targetTaskId, type } } };

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    update,
    { returnDocument: "after" }
  );

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ message: "Dependency removed" });
});

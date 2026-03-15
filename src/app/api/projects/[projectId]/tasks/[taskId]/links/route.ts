import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";

// Add a blockedBy link
export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { blockedByTaskId } = await request.json();

  if (!blockedByTaskId) {
    return NextResponse.json(
      { error: "blockedByTaskId is required" },
      { status: 400 }
    );
  }

  if (blockedByTaskId === taskId) {
    return NextResponse.json(
      { error: "A task cannot block itself" },
      { status: 400 }
    );
  }

  // Verify both tasks exist in the same project
  const [task, blocker] = await Promise.all([
    Task.findOne({ _id: taskId, project: projectId }),
    Task.findOne({ _id: blockedByTaskId, project: projectId }),
  ]);

  if (!task || !blocker) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
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
    if (current === blockedByTaskId) {
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
    $addToSet: { blockedBy: blockedByTaskId },
  });

  return NextResponse.json({ message: "Link added" });
});

// Remove a blockedBy link
export const DELETE = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { blockedByTaskId } = await request.json();

  if (!blockedByTaskId) {
    return NextResponse.json(
      { error: "blockedByTaskId is required" },
      { status: 400 }
    );
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $pull: { blockedBy: blockedByTaskId } },
    { new: true }
  );

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ message: "Link removed" });
});

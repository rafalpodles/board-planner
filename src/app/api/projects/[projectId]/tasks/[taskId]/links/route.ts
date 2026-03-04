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

  // Check for circular dependency:
  // If we add "taskId is blocked by blockedByTaskId",
  // we need to verify that taskId doesn't already block blockedByTaskId
  // (directly or transitively). In other words, check if blockedByTaskId
  // can reach taskId by following blockedBy links.
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

    // Find tasks that are blocked by `current` (i.e. current is in their blockedBy)
    const dependents = await Task.find(
      { blockedBy: current, project: projectId },
      "_id"
    ).lean();
    for (const dep of dependents) {
      if (!visited.has(dep._id.toString())) {
        queue.push(dep._id.toString());
      }
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
  const { taskId } = await params;
  await connectDB();

  const { blockedByTaskId } = await request.json();

  if (!blockedByTaskId) {
    return NextResponse.json(
      { error: "blockedByTaskId is required" },
      { status: 400 }
    );
  }

  await Task.findByIdAndUpdate(taskId, {
    $pull: { blockedBy: blockedByTaskId },
  });

  return NextResponse.json({ message: "Link removed" });
});

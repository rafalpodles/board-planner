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

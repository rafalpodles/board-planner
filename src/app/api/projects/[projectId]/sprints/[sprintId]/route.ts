import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Sprint } from "@/models/sprint";
import { Task } from "@/models/task";
import { SprintStatus } from "@/types";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  const sprint = await Sprint.findOne({ _id: sprintId, project: projectId }).lean();
  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  const taskCount = await Task.countDocuments({ sprint: sprintId });
  const doneCount = await Task.countDocuments({ sprint: sprintId, status: "done" });

  return NextResponse.json({ ...sprint, taskCount, doneCount });
});

export const PUT = withProjectAccess(async (request, { params }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  const body = await request.json();

  const allowed = ["name", "startDate", "endDate", "goal", "status"];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = field === "startDate" || field === "endDate"
        ? new Date(body[field])
        : body[field];
    }
  }

  // If activating, deactivate other active sprints in this project
  if (updates.status === "active") {
    await Sprint.updateMany(
      { project: projectId, status: "active", _id: { $ne: sprintId } },
      { $set: { status: "completed" } }
    );
  }

  // If completing, optionally move incomplete tasks to backlog
  if (updates.status === "completed" && body.moveIncompleteToBacklog) {
    await Task.updateMany(
      { sprint: sprintId, status: { $ne: "done" } },
      { $set: { sprint: null } }
    );
  }

  // If completing, optionally move incomplete tasks to next sprint
  if (updates.status === "completed" && body.moveIncompleteToSprint) {
    await Task.updateMany(
      { sprint: sprintId, status: { $ne: "done" } },
      { $set: { sprint: body.moveIncompleteToSprint } }
    );
  }

  const sprint = await Sprint.findOneAndUpdate(
    { _id: sprintId, project: projectId },
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  return NextResponse.json(sprint);
});

export const DELETE = withProjectAccess(async (_request, { params }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  const sprint = await Sprint.findOneAndDelete({
    _id: sprintId,
    project: projectId,
  });

  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  // Move all tasks in this sprint back to backlog
  await Task.updateMany(
    { sprint: sprintId },
    { $set: { sprint: null } }
  );

  return NextResponse.json({ message: "Sprint deleted" });
});

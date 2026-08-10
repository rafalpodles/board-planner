import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Sprint } from "@/models/sprint";
import { Task } from "@/models/task";
import { SprintStatus, SPRINT_STATUSES } from "@/types";
import { Project } from "@/models/project";
import { columnIdsWithRole } from "@/lib/columns";

// A board may define more than one done column, and a project that renamed its board has none
// called "done" at all. Resolved per request from the project's own columns.
async function doneColumnIds(projectId: string): Promise<string[]> {
  const project = await Project.findById(projectId, "columns").lean();
  return columnIdsWithRole(project, "done");
}

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  const sprint = await Sprint.findOne({ _id: sprintId, project: projectId }).lean();
  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  const taskCount = await Task.countDocuments({ sprint: sprintId });
  const doneCount = await Task.countDocuments({
    sprint: sprintId,
    status: { $in: await doneColumnIds(projectId) },
  });

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

  if (updates.status && !SPRINT_STATUSES.includes(updates.status as SprintStatus)) {
    return NextResponse.json({ error: "Invalid sprint status" }, { status: 400 });
  }

  // If activating, deactivate other active sprints in this project
  if (updates.status === "active") {
    await Sprint.updateMany(
      { project: projectId, status: "active", _id: { $ne: sprintId } },
      { $set: { status: "completed" } }
    );
  }

  // Unfinished means "not in a done-role column", not "not literally called done". Keyed on the
  // id, a project whose board was renamed had every finished task look unfinished and get dragged
  // into the next sprint — the one case in this ticket that moves somebody's work without asking.
  if (updates.status === "completed" && (body.moveIncompleteToBacklog || body.moveIncompleteToSprint)) {
    const unfinished = { sprint: sprintId, status: { $nin: await doneColumnIds(projectId) } };

    if (body.moveIncompleteToBacklog) {
      await Task.updateMany(unfinished, { $set: { sprint: null } });
    }
    if (body.moveIncompleteToSprint) {
      await Task.updateMany(unfinished, { $set: { sprint: body.moveIncompleteToSprint } });
    }
  }

  const sprint = await Sprint.findOneAndUpdate(
    { _id: sprintId, project: projectId },
    { $set: updates },
    { returnDocument: "after", runValidators: true }
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

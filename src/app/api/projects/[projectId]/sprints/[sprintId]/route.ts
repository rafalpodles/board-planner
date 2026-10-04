import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { withProjectAccess } from "@/lib/middleware";
import { SprintStatus, SPRINT_STATUSES } from "@/types";
import { columnIdsWithRole } from "@/lib/columns";

// A board may define more than one done column, and a project that renamed its board has none
// called "done" at all. Resolved per request from the project's own columns.
async function doneColumnIds(db: ScopedDb, projectId: string): Promise<string[]> {
  const project = await db.Project.findById(projectId, "columns").lean();
  return columnIdsWithRole(project, "done");
}

// `withProjectAccess` authorises the projectId in the path and nothing else — `withResolvedIds`
// special-cases taskId and hands sprintId through raw. So every handler here has to establish
// that the sprint is this project's before it touches anything, and every task query has to say
// `project` as well as `sprint`. Without that a member of any board could act on a sprint id
// belonging to a board they cannot read (BP-314).
async function ownedSprintId(
  db: ScopedDb,
  projectId: string,
  sprintId: string
): Promise<string | null> {
  if (!isValidObjectId(sprintId)) return null;
  const sprint = await db.Sprint.findOne({ _id: sprintId, project: projectId }).select("_id").lean();
  return sprint ? sprintId : null;
}

export const GET = withProjectAccess(async (_request, { params, db }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  if (!isValidObjectId(sprintId)) {
    return NextResponse.json({ error: "Invalid sprint id" }, { status: 400 });
  }

  const sprint = await db.Sprint.findOne({ _id: sprintId, project: projectId }).lean();
  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  const taskCount = await db.Task.countDocuments({ project: projectId, sprint: sprintId });
  const doneCount = await db.Task.countDocuments({
    project: projectId,
    sprint: sprintId,
    status: { $in: await doneColumnIds(db, projectId) },
  });

  return NextResponse.json({ ...sprint, taskCount, doneCount });
});

export const PUT = withProjectAccess(async (request, { params, db }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  // Before any write. The task moves below used to run first and the ownership check second,
  // so a refused request still emptied somebody else's sprint and answered 404 (BP-314).
  if (!isValidObjectId(sprintId)) {
    return NextResponse.json({ error: "Invalid sprint id" }, { status: 400 });
  }
  if (!(await ownedSprintId(db, projectId, sprintId))) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

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
    await db.Sprint.updateMany(
      { project: projectId, status: "active", _id: { $ne: sprintId } },
      { $set: { status: "completed" } }
    );
  }

  // Unfinished means "not in a done-role column", not "not literally called done". Keyed on the
  // id, a project whose board was renamed had every finished task look unfinished and get dragged
  // into the next sprint — the one case in this ticket that moves somebody's work without asking.
  if (updates.status === "completed" && (body.moveIncompleteToBacklog || body.moveIncompleteToSprint)) {
    // Every refusal ahead of every write. The destination is a caller-supplied id like the one in
    // the path, so it gets the same ownership check — and it gets it *here*, because validating it
    // inside the second branch let the first branch's sweep commit before the 400. That is the same
    // write-then-refuse shape this whole change exists to remove.
    let destination: string | null = null;
    if (body.moveIncompleteToSprint) {
      destination = await ownedSprintId(db, projectId, String(body.moveIncompleteToSprint));
      if (!destination) {
        return NextResponse.json({ error: "Destination sprint not found" }, { status: 400 });
      }
    }

    // `project` as well as `sprint`: the sprint id is owned by this project, but a task carrying
    // it may not be — nothing stopped a cross-project reference being written until BP-314
    const unfinished = {
      project: projectId,
      sprint: sprintId,
      status: { $nin: await doneColumnIds(db, projectId) },
    };

    // Exclusive: a body carrying both used to run the sweep and then the move over the top of it
    if (destination) {
      await db.Task.updateMany(unfinished, { $set: { sprint: destination } });
    } else if (body.moveIncompleteToBacklog) {
      await db.Task.updateMany(unfinished, { $set: { sprint: null } });
    }
  }

  const sprint = await db.Sprint.findOneAndUpdate(
    { _id: sprintId, project: projectId },
    { $set: updates },
    { returnDocument: "after", runValidators: true }
  );

  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  return NextResponse.json(sprint);
});

export const DELETE = withProjectAccess(async (_request, { params, db }) => {
  const { projectId, sprintId } = await params;
  await connectDB();

  if (!isValidObjectId(sprintId)) {
    return NextResponse.json({ error: "Invalid sprint id" }, { status: 400 });
  }

  const sprint = await db.Sprint.findOneAndDelete({
    _id: sprintId,
    project: projectId,
  });

  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  // Move all tasks in this sprint back to backlog
  await db.Task.updateMany(
    { project: projectId, sprint: sprintId },
    { $set: { sprint: null } }
  );

  return NextResponse.json({ message: "Sprint deleted" });
});

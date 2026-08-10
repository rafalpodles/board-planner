import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Task } from "@/models/task";
import { columnFor } from "@/lib/columns";
import "@/models/project";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const filter: Record<string, unknown> = { assignee: user._id };

  // Members can only see tasks from their allowed projects
  if (user.role !== "admin") {
    const allowed = (await accessibleProjectIds(user)) ?? [];
    filter.project = { $in: allowed };
  }

  const tasks = await Task.find(filter)
    .populate("project", "name key icon columns")
    .populate("assignee", "username fullName")
    .sort({ updatedAt: -1 })
    .lean();

  // Resolved here, not on the page. This list spans projects, so the client would need every one
  // of their boards to say what a status means — and it used to guess from a fixed list of ids,
  // which meant a renamed column had no colour, no label and never counted as done.
  //
  // The columns themselves are dropped again: they were loaded to answer one question per task,
  // and sending a board per row would be the same waste in the other direction.
  return NextResponse.json(
    tasks.map((task) => {
      const project = task.project as { columns?: never } | null;
      const column = columnFor(project as never, task.status);
      const { columns: _columns, ...rest } = (project ?? {}) as Record<string, unknown>;

      return {
        ...task,
        project: project ? rest : project,
        // Absent when the task sits in a column the project no longer has, which is what happens
        // to work left behind by a deleted column. The page shows it rather than hiding it.
        statusRole: column?.role ?? null,
        statusLabel: column?.label ?? task.status,
        statusColor: column?.color ?? null,
      };
    })
  );
});

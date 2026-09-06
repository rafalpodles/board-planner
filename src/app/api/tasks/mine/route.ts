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

  if (user.role !== "admin") {
    const allowed = (await accessibleProjectIds(user)) ?? [];
    filter.project = { $in: allowed };
  }

  const tasks = await Task.find(filter)
    .populate("project", "name key icon columns")
    .populate("assignee", "username fullName")
    .sort({ updatedAt: -1 })
    .lean();

  return NextResponse.json(
    tasks.map((task) => {
      const project = task.project as { columns?: never } | null;
      const column = columnFor(project as never, task.status);
      const { columns: _columns, ...rest } = (project ?? {}) as Record<string, unknown>;

      return {
        ...task,
        project: project ? rest : project,
        statusRole: column?.role ?? null,
        statusLabel: column?.label ?? task.status,
        statusColor: column?.color ?? null,
      };
    })
  );
});

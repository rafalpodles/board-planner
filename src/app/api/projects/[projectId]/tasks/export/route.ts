import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { TASK_STATUSES, TaskStatus } from "@/types";
import { exportTasksToMarkdown } from "@/lib/markdown";

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const filters = body.filters ?? {};

  // Build filter
  const query: Record<string, unknown> = { project: projectId };

  if (filters.status) {
    const statuses = (
      typeof filters.status === "string"
        ? filters.status.split(",")
        : [filters.status]
    ).filter((s: string): s is TaskStatus =>
      TASK_STATUSES.includes(s as TaskStatus)
    );
    if (statuses.length > 0) {
      query.status = { $in: statuses };
    }
  }

  if (filters.assignee) {
    query.assignee = filters.assignee;
  }

  if (filters.component) {
    query.component = filters.component;
  }

  if (filters.category) {
    query.category = filters.category;
  }

  const tasks = await Task.find(query)
    .sort({ order: 1, createdAt: -1 })
    .populate({ path: "assignee", select: "username fullName" });

  const markdown = exportTasksToMarkdown(tasks);

  return NextResponse.json({ markdown });
});

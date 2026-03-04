import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Task } from "@/models/task";
import "@/models/project";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const filter: Record<string, unknown> = { assignee: user._id };

  // Members can only see tasks from their allowed projects
  if (user.role !== "admin") {
    const allowed = user.allowedProjects || [];
    filter.project = { $in: allowed };
  }

  const tasks = await Task.find(filter)
    .populate("project", "name key")
    .populate("assignee", "username fullName")
    .sort({ updatedAt: -1 });

  return NextResponse.json(tasks);
});

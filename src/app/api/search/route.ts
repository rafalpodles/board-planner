import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Task } from "@/models/task";
import "@/models/project";

export const GET = withAuth(async (request, { user }) => {
  await connectDB();

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  const filter: Record<string, unknown> = {};

  // Members can only see tasks from their allowed projects
  if (user.role !== "admin") {
    const allowed = user.allowedProjects || [];
    filter.project = { $in: allowed };
  }

  // Check if query looks like a task key (e.g. "CP-12")
  const keyMatch = q.match(/^([A-Z]{1,10})-(\d+)$/i);

  if (keyMatch) {
    // Search by exact task key
    const projectKey = keyMatch[1].toUpperCase();
    const taskNumber = parseInt(keyMatch[2], 10);

    const tasks = await Task.find({ ...filter, taskNumber })
      .populate("project", "name key")
      .populate("assignee", "username fullName")
      .lean();

    // Filter by project key (populated)
    const matched = tasks.filter(
      (t) =>
        t.project &&
        typeof t.project === "object" &&
        "key" in t.project &&
        (t.project as { key: string }).key === projectKey
    );

    return NextResponse.json(matched);
  }

  // Text search on title and description
  const regex = { $regex: q, $options: "i" };
  filter.$or = [{ title: regex }, { description: regex }];

  const tasks = await Task.find(filter)
    .populate("project", "name key")
    .populate("assignee", "username fullName")
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  return NextResponse.json(tasks);
});

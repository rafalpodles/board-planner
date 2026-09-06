import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Task } from "@/models/task";
import { DEFAULT_PRIORITY } from "@/types";
import "@/models/project";

function withPriorityDefault<T extends { priority?: string }>(tasks: T[]): T[] {
  return tasks.map((t) => ({ ...t, priority: t.priority ?? DEFAULT_PRIORITY }));
}

export const GET = withAuth(async (request, { user }) => {
  await connectDB();

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  const filter: Record<string, unknown> = {};

  if (user.role !== "admin") {
    const allowed = (await accessibleProjectIds(user)) ?? [];
    filter.project = { $in: allowed };
  }

  const keyMatch = q.match(/^([A-Z]{1,10})-(\d+)$/i);

  if (keyMatch) {
    const projectKey = keyMatch[1].toUpperCase();
    const taskNumber = parseInt(keyMatch[2], 10);

    const tasks = await Task.find({ ...filter, taskNumber })
      .populate("project", "name key")
      .populate("assignee", "username fullName")
      .lean();

    const matched = tasks.filter(
      (t) =>
        t.project &&
        typeof t.project === "object" &&
        "key" in t.project &&
        (t.project as { key: string }).key === projectKey
    );

    return NextResponse.json(withPriorityDefault(matched));
  }

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = { $regex: escaped, $options: "i" };
  filter.$or = [{ title: regex }, { description: regex }];

  const tasks = await Task.find(filter)
    .populate("project", "name key")
    .populate("assignee", "username fullName")
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  return NextResponse.json(withPriorityDefault(tasks));
});

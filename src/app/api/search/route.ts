import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { DEFAULT_PRIORITY } from "@/types";
import { PROJECT_KEY_PATTERN } from "@/lib/urls";

// Lean queries skip schema defaults, so tasks predating the priority field need it applied here
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

  // Members can only see tasks from their allowed projects
  const allowed = user.role === "admin" ? null : ((await accessibleProjectIds(user)) ?? []);
  if (allowed) {
    filter.project = { $in: allowed };
  }

  // A key is whatever the rule allows — letters, digits, hyphens and underscores, up to the cap —
  // followed by the task's number. The prefix is taken greedily and validated rather than described
  // again here: a key may itself contain a hyphen, so `BP-2-14` is task 14 of the board keyed
  // `BP-2`, and a regex restating the shape drifts from the rule the way this one had (BP-573).
  const keyMatch = q.match(/^(.+)-(\d{1,9})$/);
  const candidate = keyMatch?.[1] ?? "";

  if (keyMatch && PROJECT_KEY_PATTERN.test(candidate)) {
    const taskNumber = parseInt(keyMatch[2], 10);
    // Resolved against the board rather than compared to the populated key: that is the only way a
    // key the project used to answer to still finds its task, as in-prose references already do
    const escapedKey = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const byKey = new RegExp(`^${escapedKey}$`, "i");
    const project = await Project.findOne({
      $or: [{ key: byKey }, { formerKeys: byKey }],
    })
      .select("_id")
      .lean();

    // Named explicitly rather than by overwriting `filter.project`, which is what carries the
    // reader's access: a key that resolves to a board they cannot see must find nothing, not
    // everything
    const reachable = !allowed || allowed.some((id) => String(id) === String(project?._id));

    if (project && reachable) {
      const tasks = await Task.find({ ...filter, project: project._id, taskNumber })
        .populate("project", "name key")
        .populate("assignee", "username fullName")
        .lean();

      return NextResponse.json(withPriorityDefault(tasks));
    }
    if (project) return NextResponse.json([]);
  }

  // Text search on title and description
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

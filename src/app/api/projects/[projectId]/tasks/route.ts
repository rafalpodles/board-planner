import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { DEFAULT_PRIORITY, PRIORITIES } from "@/types";
import { createTask, toApiExecution, taskPopulateFields } from "@/lib/task-service";
import { getColumnIds } from "@/lib/columns";
import { Worker } from "@/models/worker";
import { User } from "@/models/user";
import { Project } from "@/models/project";
import { ITaskExecution } from "@/types";

export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);

  const filter: Record<string, unknown> = { project: projectId };

  const statusParam = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  const board =
    statusParam || category
      ? await Project.findById(projectId, "categories columns").lean()
      : null;

  if (statusParam) {
    const statuses = statusParam.split(",").map((id) => id.trim()).filter(Boolean);
    if (statuses.length > 0) {
      const columnIds = getColumnIds(board);
      if (!statuses.some((id) => columnIds.includes(id))) {
        return NextResponse.json(
          {
            error: `Invalid status "${statusParam.slice(0, 64)}" — project columns: ${columnIds.join(", ")}`,
          },
          { status: 400 }
        );
      }
      filter.status = { $in: statuses };
    }
  }

  const assignee = url.searchParams.get("assignee");
  if (assignee) {
    const user = await User.findOne({ username: assignee.toLowerCase() }, "_id").lean();
    if (user) {
      filter.assignee = user._id;
    } else if (isValidObjectId(assignee)) {
      filter.assignee = assignee;
    } else {
      return NextResponse.json(
        { error: `No account named "@${assignee.slice(0, 64)}" — this filter takes a username.` },
        { status: 400 }
      );
    }
  }

  if (category) {
    const names = (board?.categories || []).map((c: { name: string }) => c.name);
    if (names.length > 0 && !names.includes(category)) {
      return NextResponse.json(
        { error: `Invalid category "${category.slice(0, 64)}" — project categories: ${names.join(", ")}` },
        { status: 400 }
      );
    }
    filter.category = category;
  }

  const priority = url.searchParams.get("priority");
  if (priority) {
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
      return NextResponse.json(
        { error: `Invalid priority "${priority.slice(0, 64)}" — one of: ${PRIORITIES.join(", ")}` },
        { status: 400 }
      );
    }
    filter.priority =
      priority === DEFAULT_PRIORITY ? { $in: [DEFAULT_PRIORITY, null] } : priority;
  }

  const sprint = url.searchParams.get("sprint");
  if (sprint === "backlog") {
    filter.sprint = null;
  } else if (sprint) {
    if (!isValidObjectId(sprint)) {
      return NextResponse.json({ error: "Invalid sprint id" }, { status: 400 });
    }
    filter.sprint = sprint;
  }

  const search = url.searchParams.get("search");
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { title: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
    ];
  }

  const tasks = await Task.find(filter)
    .sort({ order: 1, createdAt: -1 })
    .populate(taskPopulateFields);

  const workerNames = await workerNamesFor(tasks.map((task) => task.execution));
  return NextResponse.json(
    tasks.map((task) => ({
      ...task.toObject(),
      execution: toApiExecution(task.execution, workerNames),
    }))
  );
});

async function workerNamesFor(executions: (ITaskExecution | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(executions.filter((e) => e?.runId && e.workerId).map((e) => e!.workerId))];
  if (ids.length === 0) return new Map();
  const workers = await Worker.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(workers.map((w) => [String(w._id), w.name as string]));
}

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();

  const result = await createTask(projectId, String(user._id), body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.data, { status: 201 });
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { DEFAULT_PRIORITY } from "@/types";
import { createTask, toApiExecution } from "@/lib/task-service";

const populateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
  { path: "relations.task", select: "taskNumber title status" },
];

export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);

  // Build filter
  const filter: Record<string, unknown> = { project: projectId };

  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    // Column ids are project-defined (CP-128); unknown ids simply match nothing
    const statuses = statusParam.split(",").filter(Boolean);
    if (statuses.length > 0) {
      filter.status = { $in: statuses };
    }
  }

  const assignee = url.searchParams.get("assignee");
  if (assignee) {
    filter.assignee = assignee;
  }

  const component = url.searchParams.get("component");
  if (component) {
    filter.component = component;
  }

  const category = url.searchParams.get("category");
  if (category) {
    filter.category = category;
  }

  const priority = url.searchParams.get("priority");
  if (priority) {
    // $in with null also matches tasks predating the priority field, which default to medium
    filter.priority =
      priority === DEFAULT_PRIORITY ? { $in: [DEFAULT_PRIORITY, null] } : priority;
  }

  const label = url.searchParams.get("label");
  if (label) {
    filter.labels = label;
  }

  const sprint = url.searchParams.get("sprint");
  if (sprint === "backlog") {
    filter.sprint = null;
  } else if (sprint) {
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
    .populate(populateFields);

  // The board loads every task, so a raw document here would publish each one's whole execution
  // subdocument — run identity included — to every project member on every page load
  return NextResponse.json(
    tasks.map((task) => ({ ...task.toObject(), execution: toApiExecution(task.execution) }))
  );
});

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

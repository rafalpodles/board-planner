import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { TASK_STATUSES, TaskStatus } from "@/types";
import { logActivity } from "@/lib/activity";

const populateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
];

export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);

  // Build filter
  const filter: Record<string, unknown> = { project: projectId };

  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    const statuses = statusParam.split(",").filter((s): s is TaskStatus =>
      TASK_STATUSES.includes(s as TaskStatus)
    );
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

  const label = url.searchParams.get("label");
  if (label) {
    filter.labels = label;
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

  return NextResponse.json(tasks);
});

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();

  // Auto-increment taskNumber atomically
  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { taskCounter: 1 } },
    { new: true }
  );

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Resolve assignee username to ObjectId
  let assigneeId = null;
  if (body.assignee) {
    const assigneeUser = await User.findOne({
      username: body.assignee.toLowerCase(),
    });
    if (assigneeUser) {
      assigneeId = assigneeUser._id;
    }
  }

  const task = await Task.create({
    project: projectId,
    taskNumber: project.taskCounter,
    title: body.title,
    description: body.description ?? "",
    difficulty: body.difficulty ?? "M",
    component: body.component ?? "",
    category: body.category ?? "user-story",
    status: body.status ?? "planned",
    assignee: assigneeId,
    acceptanceCriteria: body.acceptanceCriteria ?? "",
    labels: Array.isArray(body.labels) ? body.labels : [],
    order: body.order ?? 0,
    createdBy: user._id,
  });

  const populated = await Task.findById(task._id).populate(populateFields);

  await logActivity(task._id, user._id, "created");

  return NextResponse.json(populated, { status: 201 });
});

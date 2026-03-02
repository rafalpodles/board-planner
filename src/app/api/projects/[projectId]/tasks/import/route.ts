import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { parseTasksFromMarkdown } from "@/lib/markdown";

export const POST = withAuth(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { markdown } = await request.json();

  if (!markdown || typeof markdown !== "string") {
    return NextResponse.json(
      { error: "markdown field is required" },
      { status: 400 }
    );
  }

  let parsed;
  try {
    parsed = parseTasksFromMarkdown(markdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid markdown";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (parsed.length === 0) {
    return NextResponse.json(
      { error: "No tasks found in markdown" },
      { status: 400 }
    );
  }

  // Collect unique assignee usernames and resolve them in bulk
  const usernames = [
    ...new Set(
      parsed
        .map((t) => t.assignee?.toLowerCase())
        .filter((u): u is string => !!u)
    ),
  ];

  const users = await User.find({ username: { $in: usernames } });
  const usernameToId = new Map(
    users.map((u) => [u.username, u._id])
  );

  const created = [];

  for (const parsedTask of parsed) {
    // Auto-increment taskNumber atomically
    const project = await Project.findOneAndUpdate(
      { _id: projectId },
      { $inc: { taskCounter: 1 } },
      { new: true }
    );

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    const assigneeId = parsedTask.assignee
      ? usernameToId.get(parsedTask.assignee.toLowerCase()) ?? null
      : null;

    const task = await Task.create({
      project: projectId,
      taskNumber: project.taskCounter,
      title: parsedTask.title,
      description: parsedTask.description ?? "",
      difficulty: parsedTask.difficulty ?? "M",
      component: parsedTask.component ?? "",
      category: parsedTask.category,
      status: parsedTask.status ?? "planned",
      assignee: assigneeId,
      acceptanceCriteria: parsedTask.acceptanceCriteria ?? "",
      order: 0,
      createdBy: user._id,
    });

    created.push(task);
  }

  // Populate all created tasks
  const populatedTasks = await Task.find({
    _id: { $in: created.map((t) => t._id) },
  }).populate([
    { path: "assignee", select: "username fullName" },
    { path: "createdBy", select: "username fullName" },
  ]);

  return NextResponse.json(populatedTasks, { status: 201 });
});

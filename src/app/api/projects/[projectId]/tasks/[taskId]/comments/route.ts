import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Comment } from "@/models/comment";
import { Task } from "@/models/task";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import { createNotifications, collectRecipients, resolveMentions } from "@/lib/in-app-notifications";
import { Project } from "@/models/project";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to project
  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const comments = await Comment.find({ task: taskId })
    .sort({ createdAt: 1 })
    .populate("author", "username fullName")
    .populate("reactions.user", "username fullName");

  return NextResponse.json(comments);
});

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to project
  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const { body } = await request.json();

  if (!body || typeof body !== "string" || !body.trim()) {
    return NextResponse.json(
      { error: "Comment body is required" },
      { status: 400 }
    );
  }

  const comment = await Comment.create({
    task: taskId,
    author: user._id,
    body: body.trim(),
  });

  const populated = await Comment.findById(comment._id).populate({
    path: "author",
    select: "username fullName",
  });

  await Promise.all([
    logActivity(taskId, user._id, "comment_added"),
    // Auto-watch task on comment
    Task.findByIdAndUpdate(taskId, { $addToSet: { watchers: user._id } }),
  ]);

  const eventPayload = {
    project: { key: "", name: "" },
    task: {
      taskKey: `${task.taskNumber}`,
      title: task.title,
      status: task.status,
    },
    data: { commentBody: body.trim().substring(0, 200), author: user.username },
  };
  dispatchWebhooks(projectId, "comment_added", eventPayload);
  dispatchNotifications(projectId, "comment_added", eventPayload);

  // In-app notifications for comment
  const project = await Project.findById(projectId, "key").lean();
  const taskKey = project ? `${project.key}-${task.taskNumber}` : `#${task.taskNumber}`;
  const recipients = collectRecipients(task);
  createNotifications({
    type: "comment_added",
    taskId,
    projectId,
    actorId: String(user._id),
    title: `New comment on ${taskKey}`,
    body: body.trim().substring(0, 120),
    recipientIds: recipients,
  });

  // @mention notifications
  const mentionedIds = await resolveMentions(body);
  if (mentionedIds.length > 0) {
    createNotifications({
      type: "mentioned",
      taskId,
      projectId,
      actorId: String(user._id),
      title: `You were mentioned in ${taskKey}`,
      body: body.trim().substring(0, 120),
      recipientIds: mentionedIds,
    });
  }

  return NextResponse.json(populated, { status: 201 });
});

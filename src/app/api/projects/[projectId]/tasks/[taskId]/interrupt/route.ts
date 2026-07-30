import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { addComment, changeStatus } from "@/lib/task-service";
import { effectiveColumns, roleOf } from "@/lib/columns";

export const POST = withProjectAccess(async (_request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const task = await Task.findOne({ _id: taskId, project: projectId }, "status").lean();
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (roleOf(project, task.status) !== "active") {
    return NextResponse.json(
      { error: "Only a task that is actively being worked on can be interrupted" },
      { status: 400 }
    );
  }

  const columns = effectiveColumns(project?.columns);
  const target = columns.find((c) => c.role === "approved") ?? columns.find((c) => c.role === "backlog");
  if (!target) {
    return NextResponse.json(
      { error: "This project has no column to return interrupted work to" },
      { status: 400 }
    );
  }

  const moved = await changeStatus(projectId, taskId, target.id, String(user._id));
  if (!moved.ok) {
    return NextResponse.json({ error: moved.error }, { status: moved.status });
  }

  // The annotation is how a Claude Code session learns it should stop: it sees the
  // comment (and the status having moved back) at its next board check
  const annotation = await addComment(
    projectId,
    taskId,
    `⛔ **Interrupt requested by @${user.username}** — stop work on this task at the next check and do not continue the pipeline. Status was moved back to "${target.label}". Work already committed is untouched; describe where you stopped before dropping the task.`,
    { id: String(user._id), username: user.username }
  );

  return NextResponse.json({
    task: moved.data,
    comment: annotation.ok ? annotation.data : null,
    movedTo: target.id,
  });
});

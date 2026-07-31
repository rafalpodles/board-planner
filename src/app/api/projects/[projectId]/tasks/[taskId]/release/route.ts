import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { releaseTask } from "@/lib/task-service";

export const POST = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await releaseTask(projectId, taskId);
  if (!task) {
    return NextResponse.json({ error: "Task not found or not releasable" }, { status: 404 });
  }

  return NextResponse.json(task);
});

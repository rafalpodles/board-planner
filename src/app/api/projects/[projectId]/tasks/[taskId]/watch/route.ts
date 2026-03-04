import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";

// Toggle watch — adds user if not watching, removes if already watching
export const POST = withProjectAccess(async (_request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const userId = user._id.toString();
  const isWatching = (task.watchers || []).some(
    (w) => w.toString() === userId
  );

  if (isWatching) {
    await Task.findByIdAndUpdate(taskId, {
      $pull: { watchers: user._id },
    });
  } else {
    await Task.findByIdAndUpdate(taskId, {
      $addToSet: { watchers: user._id },
    });
  }

  return NextResponse.json({ watching: !isWatching });
});

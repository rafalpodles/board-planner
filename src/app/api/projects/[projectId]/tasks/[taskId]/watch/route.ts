import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";

// Toggle watch — adds user if not watching, removes if already watching
export const POST = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await db.Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const userId = user._id.toString();
  const isWatching = (task.watchers || []).some(
    (w) => w.toString() === userId
  );

  if (isWatching) {
    await db.Task.findByIdAndUpdate(taskId, {
      $pull: { watchers: user._id },
    });
  } else {
    await db.Task.findByIdAndUpdate(taskId, {
      $addToSet: { watchers: user._id },
    });
  }

  return NextResponse.json({ watching: !isWatching });
});

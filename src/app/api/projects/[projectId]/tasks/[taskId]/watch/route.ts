import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";

// Toggle watch — adds user if not watching, removes if already watching. A body of
// { watching: boolean } says the state wanted instead: one atomic update with no read before it, so
// asking twice, or twice at once, ends in the state asked for (BP-905)
export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = (await request.json().catch(() => null)) as { watching?: unknown } | null;
  if (body && body.watching !== undefined) {
    if (typeof body.watching !== "boolean") {
      return NextResponse.json({ error: "watching must be true or false" }, { status: 400 });
    }
    const updated = await db.Task.findOneAndUpdate(
      { _id: taskId, project: projectId },
      body.watching ? { $addToSet: { watchers: user._id } } : { $pull: { watchers: user._id } }
    );
    if (!updated) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ watching: body.watching });
  }

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

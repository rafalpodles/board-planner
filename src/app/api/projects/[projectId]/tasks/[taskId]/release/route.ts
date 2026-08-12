import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { releaseTask } from "@/lib/task-service";

export const POST = withProjectAccessOrWorker(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const refund = (body as { refund?: unknown })?.refund !== false;

  // A machine releases what it holds and nothing else. The header is not self-asserted: the
  // middleware verified this credential against exactly this worker id. A person clearing a stuck
  // card from the board keeps the broad release, which is what that button is for (BP-305).
  const workerId = user.viaMachineCredential ? request.headers.get("x-worker-id") : null;

  const task = await releaseTask(projectId, taskId, {
    refund,
    ...(workerId ? { workerId } : {}),
  });
  if (!task) {
    return NextResponse.json({ error: "Task not found or not releasable" }, { status: 404 });
  }

  return NextResponse.json(task);
});

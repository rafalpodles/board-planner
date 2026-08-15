import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { releaseTask } from "@/lib/task-service";

export const POST = withProjectAccessOrWorker(async (request, { params, user, workerId }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const refund = (body as { refund?: unknown })?.refund !== false;

  // A machine releases what it holds and nothing else — and "machine" is decided by the credential,
  // not by which header arrived. Reading x-worker-id here meant a cp_ or cpat_ token, which takes
  // the person branch and never carries that header, fell through to the broad release of whatever
  // run held the task (BP-336). The verified id comes from the middleware; a machine without one
  // gets no release at all. A person's broad release is unchanged — it is how a stuck card is
  // cleared from the board.
  if (user.viaMachineCredential && !workerId) {
    return NextResponse.json(
      { error: "a machine credential may only release the run it holds" },
      { status: 403 }
    );
  }

  const task = await releaseTask(projectId, taskId, {
    refund,
    ...(workerId ? { workerId } : {}),
  });
  if (!task) {
    return NextResponse.json({ error: "Task not found or not releasable" }, { status: 404 });
  }

  return NextResponse.json(task);
});

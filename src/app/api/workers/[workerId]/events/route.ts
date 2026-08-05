import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withWorker } from "@/lib/middleware";
import { phaseFrom, recordTaskPhase } from "@/lib/task-service";

// withWorker owns the credential and 403s a path segment that names someone else's worker; the
// update filter owns the rest — a phase only lands on a task this worker still holds under this
// run, since every exit from the active state clears the run identity along with the phase.
export const POST = withWorker(async (request, { worker }) => {
  // Every other withWorker route refuses a killed worker, and this one is not the exception: an
  // abort is asynchronous, so without this the board would keep advancing a run the admin just
  // stopped — at exactly the moment the operator needs the badge to be true
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) ?? {};

  const { taskId, runId, seq } = body;
  if (typeof taskId !== "string" || !isValidObjectId(taskId)) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  // A NaN or negative seq would make the ordering guard match nothing, or everything, silently
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    return NextResponse.json({ error: "seq must be a positive integer" }, { status: 400 });
  }

  const phase = phaseFrom(body.phase);
  if (!phase) {
    return NextResponse.json({ error: "phase is required" }, { status: 400 });
  }

  const applied = await recordTaskPhase({
    taskId,
    workerId: String(worker._id),
    runId,
    seq,
    phase,
  });

  // A worker that no longer holds the task, or an event overtaken by a newer one, wrote nothing —
  // which is the expected outcome of a race, not an error the run should react to
  return NextResponse.json({ applied });
});

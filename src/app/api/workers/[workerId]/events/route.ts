import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withWorker } from "@/lib/middleware";
import { phaseFrom, recordTaskPhase } from "@/lib/task-service";

export const POST = withWorker(async (request, { worker }) => {
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

  return NextResponse.json({ applied });
});

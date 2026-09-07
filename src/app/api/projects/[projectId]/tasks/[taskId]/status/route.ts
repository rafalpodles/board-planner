import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { changeStatus } from "@/lib/task-service";
import { withApiExecution } from "@/lib/task-execution-view";
import { machineMayNotForce, MACHINE_FORCE_REFUSAL } from "@/lib/force-guard";

export const PATCH = withProjectAccessOrWorker(async (request, { params, user, workerId }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // `force` is how a person says "take the task from that worker" after being told it is running.
  // Opt-in per request rather than a setting: the refusal is only useful if it is the default.
  const { status, force } = await request.json();

  // Never for a machine credential. CLAUDE.md already records that the PM agent gets no force
  // because "an unattended agent must not take work off a machine"; a worker is exactly such an
  // agent, and force here took a task off another worker mid-run (BP-305). The rule moved into
  // one named place once BP-320 found the sibling route missing it.
  if (machineMayNotForce(user, force)) {
    return NextResponse.json({ error: MACHINE_FORCE_REFUSAL }, { status: 403 });
  }

  const result = await changeStatus(projectId, taskId, status, String(user._id), {
    force: force === true,
    workerId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.runConflict ? { runConflict: result.runConflict } : {}) },
      { status: result.status }
    );
  }

  // The stored execution has defaults on every field, so answering with the raw document tells the
  // board a machine is holding this task and paints the red run indicator on the card the reader
  // just moved (BP-558 review)
  return NextResponse.json(await withApiExecution(result.data));
});

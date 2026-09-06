import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { changeStatus } from "@/lib/task-service";
import { machineMayNotForce, MACHINE_FORCE_REFUSAL } from "@/lib/force-guard";

export const PATCH = withProjectAccessOrWorker(async (request, { params, user, workerId }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { status, force } = await request.json();

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

  return NextResponse.json(result.data);
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { machineMayNotForce, MACHINE_FORCE_REFUSAL } from "@/lib/force-guard";
import { archiveTask, unarchiveTask } from "@/lib/task-archive-service";
import { withApiExecution } from "@/lib/task-execution-view";

export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = (await request.json().catch(() => ({}))) as { force?: unknown } | null;
  const force = body?.force;
  if (machineMayNotForce(user, force)) {
    return NextResponse.json({ error: MACHINE_FORCE_REFUSAL }, { status: 403 });
  }

  const result = await archiveTask(db, projectId, taskId, String(user._id), force === true);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.runConflict ? { runConflict: result.runConflict } : {}) },
      { status: result.status }
    );
  }
  return NextResponse.json(await withApiExecution(db, result.data));
});

export const DELETE = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const result = await unarchiveTask(db, projectId, taskId, String(user._id));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(await withApiExecution(db, result.data));
});

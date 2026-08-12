import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { changeStatus } from "@/lib/task-service";

export const PATCH = withProjectAccessOrWorker(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // `force` is how a person says "take the task from that worker" after being told it is running.
  // Opt-in per request rather than a setting: the refusal is only useful if it is the default.
  const { status, force } = await request.json();

  // Never for a machine credential. CLAUDE.md already records that the PM agent gets no force
  // because "an unattended agent must not take work off a machine"; a worker is exactly such an
  // agent, and force here took a task off another worker mid-run (BP-305).
  if (force === true && user.viaMachineCredential) {
    return NextResponse.json(
      { error: "force is not available to a machine credential" },
      { status: 403 }
    );
  }

  const result = await changeStatus(projectId, taskId, status, String(user._id), force === true);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.runConflict ? { runConflict: result.runConflict } : {}) },
      { status: result.status }
    );
  }

  return NextResponse.json(result.data);
});

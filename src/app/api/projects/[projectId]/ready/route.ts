import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { projectRepositoryUrl } from "@/lib/repository";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { machineReadinessFor } from "@/lib/worker-service";
import { claimingMachineIds } from "@/lib/machine-limit";
import { boardReadyComplete, boardReadySteps, MAX_DISMISSED_BOARD_READY } from "@/lib/board-ready";
import type { ApiBoardReady } from "@/types";

const NOTHING: ApiBoardReady = { show: false, steps: [] };

/**
 * The "Get this board ready" list. Only somebody who can change the board's settings is shown one,
 * and each step is derived from data that already exists: nothing is stored per step. The machine
 * step reads the reader's own machines only, as the handover readiness does.
 */
export const GET = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  if (!(await check(db, user, projectId, "admin"))) return NextResponse.json(NOTHING);

  const [project, workers, claiming, hasTasks, grantCount, me] = await Promise.all([
    db.Project.findById(projectId, "repositoryUrl githubRepo gitlabRepo worker").lean(),
    db.Worker.find(
      { owner: user._id },
      "enabled owner lastSeenAt repos preflight command commandIssuedAt commandAckedAt bindingError halt"
    ).lean(),
    claimingMachineIds(db),
    db.Task.exists({ project: projectId }),
    db.Grant.countDocuments({ objectType: "project", object: projectId }),
    db.User.findById(user._id, "dismissedBoardReady").lean(),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const steps = boardReadySteps({
    hasTasks: !!hasTasks,
    grantCount,
    repositoryUrl: projectRepositoryUrl(project),
    workerEnabled: !!project.worker?.enabled,
    lockedByInstance: isWorkerLockedByInstance(project.worker),
    machine: machineReadinessFor(workers, project, new Date(), claiming).state,
    readerIsInstanceAdmin: user.role === "admin",
  });

  const dismissed = (me?.dismissedBoardReady ?? []).some((id) => String(id) === String(projectId));
  const body: ApiBoardReady = { show: !dismissed && !boardReadyComplete(steps), steps };
  return NextResponse.json(body);
});

export const PUT = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const me = await db.User.findById(user._id, "dismissedBoardReady").lean();
  if (!(me?.dismissedBoardReady ?? []).some((id) => String(id) === String(projectId))) {
    await db.User.updateOne(
      { _id: user._id },
      { $push: { dismissedBoardReady: { $each: [projectId], $slice: -MAX_DISMISSED_BOARD_READY } } }
    );
  }
  return NextResponse.json({ ok: true });
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { getProjectColumns } from "@/lib/columns";
import { projectRepositoryUrl } from "@/lib/repository";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { machineReadinessFor } from "@/lib/worker-service";
import type { ApiHandoverReadiness } from "@/types";
import { claimingMachineIds } from "@/lib/machine-limit";

/**
 * What the task screen needs to say why a hand-over will not run, beyond the task itself: the
 * board's own readiness and whether the READER's own machines serve this board's repository. Never
 * anyone else's machine, and never who holds a role on the board (BP-763).
 */
export const GET = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const [project, workers, canAdmin, claiming] = await Promise.all([
    db.Project.findById(projectId, "repositoryUrl githubRepo gitlabRepo worker columns").lean(),
    db.Worker.find(
      { owner: user._id },
      "enabled owner lastSeenAt repos preflight command commandIssuedAt commandAckedAt bindingError halt"
    ).lean(),
    check(db, user, projectId, "admin"),
    claimingMachineIds(db),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const machine = machineReadinessFor(workers, project, new Date(), claiming);
  const body: ApiHandoverReadiness = {
    canAdmin,
    repositoryUrl: projectRepositoryUrl(project),
    workerEnabled: !!project.worker?.enabled,
    lockedByInstance: isWorkerLockedByInstance(project.worker),
    columns: getProjectColumns(project).map((c) => ({ role: c.role })),
    machine: machine.state,
    bindingError: machine.bindingError,
    haltedBy: machine.haltedBy,
  };
  return NextResponse.json(body);
});

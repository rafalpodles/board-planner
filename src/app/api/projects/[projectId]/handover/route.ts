import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { getProjectColumns } from "@/lib/columns";
import { projectRepositoryUrl } from "@/lib/repository";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { machineStateFor } from "@/lib/worker-service";
import type { ApiHandoverReadiness } from "@/types";

/**
 * What the task screen needs to say why a hand-over will not run, beyond the task itself: the
 * board's own readiness and whether the READER's own machines serve this board's repository. Never
 * anyone else's machine, and never who holds a role on the board (BP-763).
 */
export const GET = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const [project, workers, canAdmin] = await Promise.all([
    Project.findById(projectId, "repositoryUrl githubRepo gitlabRepo worker columns").lean(),
    Worker.find(
      { owner: user._id },
      "enabled lastSeenAt repos preflight command commandIssuedAt commandAckedAt"
    ).lean(),
    check(user, projectId, "admin"),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const body: ApiHandoverReadiness = {
    canAdmin,
    repositoryUrl: projectRepositoryUrl(project),
    workerEnabled: !!project.worker?.enabled,
    lockedByInstance: isWorkerLockedByInstance(project.worker),
    columns: getProjectColumns(project).map((c) => ({ role: c.role })),
    machine: machineStateFor(workers, project),
  };
  return NextResponse.json(body);
});

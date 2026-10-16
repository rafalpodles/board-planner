import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { getProjectColumns } from "@/lib/columns";
import { projectRepositoryUrl } from "@/lib/repository";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { machineReadinessFor } from "@/lib/worker-service";
import { hasSeveralRepositories } from "@/lib/repositories";
import { repositoryCoverage } from "@/lib/repo-match";
import { MULTI_REPOSITORY } from "@/lib/worker-capabilities";
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
    db.Project.findById(projectId, "repositoryUrl repositories githubRepo gitlabRepo worker columns").lean(),
    db.Worker.find(
      { owner: user._id },
      "enabled owner lastSeenAt repos capabilities preflight command commandIssuedAt commandAckedAt bindingError halt"
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
    ...multipleRepositories(project, workers),
  };
  return NextResponse.json(body);
});

/**
 * What the reader's own machines lack for a board that lists several repositories, judged on the one
 * that lacks least. Only the reader's machines ever reach this: whose machine holds what is not a
 * member's business.
 */
function multipleRepositories(
  project: Parameters<typeof hasSeveralRepositories>[0] & Parameters<typeof repositoryCoverage>[0],
  workers: { enabled?: boolean; repos?: { remote: string; path: string }[]; capabilities?: string[] }[]
): { machineMissing?: string[]; machineNeedsUpdate?: boolean } {
  if (!hasSeveralRepositories(project)) return {};
  const judged = workers
    .filter((w) => w.enabled !== false)
    .map((w) => ({
      missing: repositoryCoverage(project, w.repos ?? []).missing.map((r) => r.name),
      capable: (w.capabilities ?? []).includes(MULTI_REPOSITORY),
    }))
    .sort((a, b) => a.missing.length - b.missing.length || Number(b.capable) - Number(a.capable));
  const best = judged[0];
  if (!best) return {};
  return best.missing.length > 0 ? { machineMissing: best.missing } : best.capable ? {} : { machineNeedsUpdate: true };
}

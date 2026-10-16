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

  const judged = judgeMachines(project, workers);
  const machine = machineReadinessFor(judged.workers, project, new Date(), claiming);
  const body: ApiHandoverReadiness = {
    canAdmin,
    repositoryUrl: projectRepositoryUrl(project),
    workerEnabled: !!project.worker?.enabled,
    lockedByInstance: isWorkerLockedByInstance(project.worker),
    columns: getProjectColumns(project).map((c) => ({ role: c.role })),
    machine: machine.state,
    bindingError: machine.bindingError,
    haltedBy: machine.haltedBy,
    ...judged.extra,
  };
  return NextResponse.json(body);
});

type ReaderWorker = { enabled?: boolean; repos?: { remote: string; path: string }[]; capabilities?: string[] };

/**
 * Which of the reader's machines count for a board that lists several repositories, and what to say
 * when none of them can take it. The claim takes a machine only with every checkout and a worker that
 * can run them together, so the state shown is that of the machines the claim would accept, never of a
 * machine that holds one repository and would be refused: a laptop that is online with one checkout
 * must not hide a desktop that is switched off with both.
 *
 * Only the reader's own machines ever reach this: whose machine holds what is not a member's business.
 */
function judgeMachines<W extends ReaderWorker>(
  project: Parameters<typeof hasSeveralRepositories>[0] & Parameters<typeof repositoryCoverage>[0],
  workers: W[]
): { workers: W[]; extra: { machineMissing?: string[]; machineNeedsUpdate?: boolean } } {
  if (!hasSeveralRepositories(project)) return { workers, extra: {} };

  const covered = workers.map((worker) => ({
    worker,
    missing: repositoryCoverage(project, worker.repos ?? []).missing.map((r) => r.name),
    capable: (worker.capabilities ?? []).includes(MULTI_REPOSITORY),
  }));
  const whole = covered.filter((c) => c.missing.length === 0);

  const ready = whole.filter((c) => c.capable);
  if (ready.length > 0) return { workers: ready.map((c) => c.worker), extra: {} };
  if (whole.length > 0) return { workers: whole.map((c) => c.worker), extra: { machineNeedsUpdate: true } };

  const fewest = Math.min(...covered.map((c) => c.missing.length), Infinity);
  const nearest = covered.filter((c) => c.missing.length === fewest);
  return {
    workers: nearest.map((c) => c.worker),
    extra: nearest.length > 0 ? { machineMissing: nearest[0].missing } : {},
  };
}

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withWorker, protocolOf } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { RepoReport } from "@/lib/repo-match";
import { WorkerPreflight, WorkerPreflightCheck } from "@/types";
import { assignmentsFor, ownerReachableProjectIds, overriddenWorkerPolicy, touchWorker, usableRepos } from "@/lib/worker-service";

// A worker reports its own checkouts; anything else is discarded rather than trusted, since this
// list decides which projects it is offered.
function reportedRepos(value: unknown): RepoReport[] | null {
  if (!Array.isArray(value)) return null;
  const out: RepoReport[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { remote, path } = entry as { remote?: unknown; path?: unknown };
    if (typeof remote !== "string" || typeof path !== "string") continue;
    if (!remote.trim() || !path.trim()) continue;
    out.push({ remote: remote.trim(), path: path.trim() });
  }
  return out;
}

// Also worker-reported, so also rebuilt field by field rather than trusted. A malformed report is
// dropped whole: leaving the previous one standing beats storing half a verdict.
function reportedPreflight(value: unknown): WorkerPreflight | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, account, checks } = value as { ok?: unknown; account?: unknown; checks?: unknown };
  if (typeof ok !== "boolean" || !Array.isArray(checks)) return null;

  const cleaned: WorkerPreflightCheck[] = [];
  for (const entry of checks) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, ok: checkOk, detail } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || typeof checkOk !== "boolean") continue;
    cleaned.push({
      name: name.trim(),
      ok: checkOk,
      detail: typeof detail === "string" ? detail.trim().slice(0, 500) : "",
    });
  }

  return {
    ok,
    account: typeof account === "string" ? account.trim().slice(0, 200) : "",
    checks: cleaned,
    reportedAt: new Date(),
  };
}

// The only path guaranteed to survive SSE loss, so it carries both the abort
// verdict and the command acknowledgement
export const POST = withWorker(async (request, { worker }) => {
  const body = await request.json().catch(() => ({}));

  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const protocolVersion = protocolOf(request);
  const repos = reportedRepos(body.repos);
  const preflight = reportedPreflight(body.preflight);

  await touchWorker(String(worker._id), {
    // A missing/unparseable protocol header must not overwrite a valid stored version with NaN
    ...(Number.isFinite(protocolVersion) ? { protocolVersion } : {}),
    version: typeof body.version === "string" ? body.version : worker.version,
    // An ack for a command that is no longer current must not clear the newer one
    ...(body.acked && body.acked === worker.command ? { commandAckedAt: new Date() } : {}),
    ...(typeof body.bindingError === "string" ? { bindingError: body.bindingError } : {}),
    // Absent means a worker that has not been taught to report it, not one that suddenly passes
    ...(preflight ? { preflight } : {}),
  });

  // An absent list is a worker that has not been taught to report yet, not a worker that suddenly
  // has nothing — overwriting the stored inventory with [] would silently unassign it.
  await connectDB();
  if (repos) {
    await Worker.updateOne({ _id: worker._id }, { $set: { repos } });
  }

  // Two worker processes on one machine must not share a working tree, and the same decision has to
  // hold at claim time — so it is made in worker-service and used by both this route and verdictFor.
  const others = await Worker.find({ _id: { $ne: worker._id } }).select(
    "_id name host repos enabled lockedByInstance lastSeenAt createdAt"
  );
  const inventory = usableRepos(
    {
      _id: worker._id,
      name: worker.name,
      host: worker.host,
      enabled: worker.enabled,
      lockedByInstance: worker.lockedByInstance,
      lastSeenAt: worker.lastSeenAt,
      createdAt: worker.createdAt,
      repos: repos ?? worker.repos ?? [],
    },
    others as never
  );

  const [projects, reachable] = await Promise.all([
    Project.find({ "worker.enabled": true })
      .select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker")
      .lean(),
    ownerReachableProjectIds(worker),
  ]);

  return NextResponse.json({
    command: worker.command,
    commandIssuedAt: worker.commandIssuedAt ? new Date(worker.commandIssuedAt).toISOString() : null,
    // Only what an operator set: everything else resolves against the worker's own defaults, so
    // raising a default reaches every machine that never pinned it
    policy: overriddenWorkerPolicy(worker),
    assignments: assignmentsFor(inventory, projects as never, reachable),
  });
});

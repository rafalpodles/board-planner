import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withWorker, protocolOf } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { RepoReport } from "@/lib/repo-match";
import { WorkerPreflight, WorkerPreflightCheck } from "@/types";
import { assignmentsFor, ownerReachableProjectIds, overriddenWorkerPolicy, touchWorker, usableRepos } from "@/lib/worker-service";

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

export const POST = withWorker(async (request, { worker }) => {
  const body = await request.json().catch(() => ({}));

  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const protocolVersion = protocolOf(request);
  const repos = reportedRepos(body.repos);
  const preflight = reportedPreflight(body.preflight);

  await touchWorker(String(worker._id), {
    ...(Number.isFinite(protocolVersion) ? { protocolVersion } : {}),
    version: typeof body.version === "string" ? body.version : worker.version,
    ...(body.acked && body.acked === worker.command ? { commandAckedAt: new Date() } : {}),
    ...(typeof body.bindingError === "string" ? { bindingError: body.bindingError } : {}),
    ...(preflight ? { preflight } : {}),
  });

  await connectDB();
  if (repos) {
    await Worker.updateOne({ _id: worker._id }, { $set: { repos } });
  }

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
    policy: overriddenWorkerPolicy(worker),
    assignments: assignmentsFor(inventory, projects as never, reachable),
  });
});

import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { withWorker, protocolOf } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { RepoReport } from "@/lib/repo-match";
import { WorkerPreflight, WorkerPreflightCheck } from "@/types";
import { assignmentsFor, ownerReachableProjectIds, overriddenWorkerPolicy, touchWorker, usableRepos } from "@/lib/worker-service";

/**
 * Every other worker's claim and heartbeat read this inventory back, so one machine inflating its
 * own report slowed the whole fleet (BP-323). Past a bound an entry is dropped rather than cut: a
 * shortened remote would match a different repository, or none.
 */
export const MAX_REPORTED_REPOS = 200;
export const MAX_REPO_REMOTE_LENGTH = 1000;
export const MAX_REPO_PATH_LENGTH = 1000;
export const MAX_PREFLIGHT_CHECKS = 50;
export const MAX_VERSION_LENGTH = 100;
export const MAX_BINDING_ERROR_LENGTH = 2000;
const MAX_HEARTBEAT_BYTES = 512 * 1024;

// A worker reports its own checkouts; anything else is discarded rather than trusted, since this
// list decides which projects it is offered.
function reportedRepos(value: unknown): RepoReport[] | null {
  if (!Array.isArray(value)) return null;
  const out: RepoReport[] = [];
  for (const entry of value) {
    if (out.length >= MAX_REPORTED_REPOS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { remote, path } = entry as { remote?: unknown; path?: unknown };
    if (typeof remote !== "string" || typeof path !== "string") continue;
    if (!remote.trim() || !path.trim()) continue;
    if (remote.trim().length > MAX_REPO_REMOTE_LENGTH || path.trim().length > MAX_REPO_PATH_LENGTH) continue;
    out.push({ remote: remote.trim(), path: path.trim() });
  }
  return out;
}

/**
 * The sandbox check's name, and the marker its detail carries when the operator has switched the
 * confinement off (`worker/src/env.ts`'s `UNCONFINED_ESCAPE_HATCH`, `worker/src/sandbox.ts`'s
 * `UNCONFINED_ACCEPTED_DETAIL`). Held against the worker's own source by
 * `worker/src/unconfined-reason.contract.test.ts`.
 */
const SANDBOX_CHECK = "sandbox";
const UNCONFINED_MARKER = "CP_ALLOW_UNCONFINED_AGENT";

/**
 * Whether a check that PASSED did so at a cost.
 *
 * The worker says so directly since BP-606 — but enrolling a machine is self-service, so a fleet
 * runs mixed versions as a matter of course, and a worker too old to send `warn` reports the
 * unconfined sandbox as a plain pass. Read only from the flag, that machine would render a clean
 * `ready` on the fleet screen: no amber name, no line under the row, an agent running with nothing
 * confining its writes, and the instance admin — who is not the person who accepted that — told
 * nothing (found in review).
 *
 * So the one check that can warn is also recognised by what it says. A second source of truth for
 * one string, deliberately, and the contract test is what keeps the two in step.
 */
function passedAtACost(name: string, ok: boolean, warn: unknown, detail: string): boolean {
  if (!ok) return false;
  if (warn === true) return true;
  return name === SANDBOX_CHECK && detail.includes(UNCONFINED_MARKER);
}

// Also worker-reported, so also rebuilt field by field rather than trusted. A malformed report is
// dropped whole: leaving the previous one standing beats storing half a verdict.
function reportedPreflight(value: unknown): WorkerPreflight | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, account, checks } = value as { ok?: unknown; account?: unknown; checks?: unknown };
  if (typeof ok !== "boolean" || !Array.isArray(checks)) return null;

  const cleaned: WorkerPreflightCheck[] = [];
  for (const entry of checks) {
    if (cleaned.length >= MAX_PREFLIGHT_CHECKS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { name, ok: checkOk, warn, detail } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200 || typeof checkOk !== "boolean") continue;
    const text = typeof detail === "string" ? detail.trim().slice(0, 500) : "";
    cleaned.push({
      name: name.trim(),
      ok: checkOk,
      // Only on a check that passed: "failed, and also a warning" is not a state, and a worker
      // sending one would otherwise paint a red row amber (BP-606).
      warn: passedAtACost(name.trim(), checkOk, warn, text),
      detail: text,
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
  const read = await readJsonBody<Record<string, unknown>>(request, MAX_HEARTBEAT_BYTES);
  // Oversized is refused; unreadable stays what it always was, a heartbeat with nothing to report
  if (!read.ok && read.reason === "too-large") return read.response;
  const body = read.ok ? read.value : {};

  if (!worker.enabled) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const protocolVersion = protocolOf(request);
  const repos = reportedRepos(body.repos);
  const preflight = reportedPreflight(body.preflight);

  await touchWorker(String(worker._id), {
    // A missing/unparseable protocol header must not overwrite a valid stored version with NaN
    ...(Number.isFinite(protocolVersion) ? { protocolVersion } : {}),
    version: typeof body.version === "string" ? body.version.slice(0, MAX_VERSION_LENGTH) : worker.version,
    // An ack for a command that is no longer current must not clear the newer one
    ...(body.acked && body.acked === worker.command ? { commandAckedAt: new Date() } : {}),
    ...(typeof body.bindingError === "string"
      ? { bindingError: body.bindingError.slice(0, MAX_BINDING_ERROR_LENGTH) }
      : {}),
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
    "_id name host repos enabled lastSeenAt createdAt"
  );
  const inventory = usableRepos(
    {
      _id: worker._id,
      name: worker.name,
      host: worker.host,
      enabled: worker.enabled,
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

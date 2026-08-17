import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth, withWorker } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { Project } from "@/models/project";
import { assignmentsFor, approvedProjectIds, overriddenWorkerPolicy, toApiWorker, usableRepos } from "@/lib/worker-service";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { InstanceAuditAction } from "@/types";

// Everything a worker document still carries is fleet management: what this machine is called,
// whether it may run, and how often it asks. What the work looks like moved to the project, so
// there is no longer a project-admin path into this route.
const ADMIN_FIELDS = ["enabled", "lockedByInstance", "name"] as const;
const POLICY_FIELDS = ["pollIntervalMs"] as const;

// The worker's own source of current policy and assignments between heartbeats, so it has to
// answer the same question the heartbeat does — otherwise a worker that reported its checkouts
// would never learn which projects they match.
export const GET = withWorker(async (_request, { worker }) => {
  // The one withWorker route that used to answer a killed worker, handing it its policy, its
  // assignments and the whole fleet inventory — an incomplete kill switch (BP-305)
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  await connectDB();
  const [projects, others] = await Promise.all([
    Project.find({ "worker.enabled": true }).select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    Worker.find({ _id: { $ne: worker._id } }).select(
      "_id name host repos enabled lockedByInstance lastSeenAt createdAt"
    ),
  ]);

  return NextResponse.json({
    ...toApiWorker(worker),
    policy: overriddenWorkerPolicy(worker),
    // This is the field the worker actually reads, so the contested-checkout decision has to be
    // applied here and not only on the heartbeat, whose assignments nothing consumes.
    assignments: assignmentsFor(
      usableRepos(worker as never, others as never),
      projects as never,
      approvedProjectIds(worker),
      Boolean(worker.owner)
    ),
  });
});

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// The project middlewares cannot be used here — they resolve params.projectId, and this
// route carries params.workerId.
export const PATCH = withAuth(async (request, { params, user }) => {
  await connectDB();

  // A machine credential must not be able to rename a laptop or clear lockedByInstance on it; that
  // requires an interactive admin session. Keyed on viaMachineCredential, not tokenScoped: an
  // unscoped admin API token leaves tokenScoped false and used to pass straight through here.
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  const { workerId } = await params;
  if (!isValidObjectId(workerId)) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }
  const worker = await Worker.findById(workerId);
  if (!worker) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) ?? null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (user.role !== "admin") {
    return NextResponse.json({ error: "Instance admin only" }, { status: 403 });
  }

  const update: Record<string, unknown> = {};

  // The only way to widen or narrow what an already-enrolled machine may claim, and the recovery
  // path for a worker enrolled before BP-305 — those have an empty set and so claim nothing.
  if ("approvedProjects" in body) {
    const ids = body.approvedProjects;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !isValidObjectId(id))) {
      return NextResponse.json(
        { error: "approvedProjects must be an array of project ids" },
        { status: 400 }
      );
    }
    const known = await Project.countDocuments({ _id: { $in: ids } });
    if (known !== new Set(ids).size) {
      return NextResponse.json({ error: "approvedProjects names a project that does not exist" }, { status: 400 });
    }
    update.approvedProjects = [...new Set(ids as string[])];
  }

  for (const field of ADMIN_FIELDS) {
    if (!(field in body)) continue;
    if (field === "name") {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      update.name = body.name.trim();
    } else {
      if (typeof body[field] !== "boolean") {
        return NextResponse.json({ error: `${field} must be a boolean` }, { status: 400 });
      }
      update[field] = body[field];
    }
  }

  const touchedPolicyFields = new Set<string>();
  for (const field of POLICY_FIELDS) {
    if (!(field in body)) continue;
    if (!isPositiveInt(body[field])) {
      return NextResponse.json({ error: `${field} must be a positive integer` }, { status: 400 });
    }
    update[`policy.${field}`] = body[field];
    touchedPolicyFields.add(field);
  }

  // Recorded even when the value matches the default: pinning a field so a later change to the
  // default does not move it is exactly what an operator may be doing here.
  if (touchedPolicyFields.size > 0) {
    update.policyOverrides = [...new Set([...(worker.policyOverrides ?? []), ...touchedPolicyFields])];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await Worker.findByIdAndUpdate(workerId, { $set: update }, { new: true });
  if (!updated) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }

  // Read off the pre-update document, which is still in hand: the entry describes a transition,
  // and "renamed to X" without the old name answers half the question somebody is asking.
  for (const entry of auditEntries(body, worker)) {
    void logInstanceAudit({ ...entry, user: String(user._id) });
  }

  return NextResponse.json(toApiWorker(updated));
});

interface WorkerBefore {
  name: string;
  enabled: boolean;
  lockedByInstance: boolean;
  policy?: { pollIntervalMs?: number };
  policyOverrides?: string[];
}

// One entry per thing that actually changed, so a request setting two fields is two rows rather
// than one row a reader has to unpack. A field sent with the value it already had is not a change
// and says nothing worth keeping.
function auditEntries(
  body: Record<string, unknown>,
  before: WorkerBefore
): { action: InstanceAuditAction; target: string; detail?: string }[] {
  const target = before.name;
  const entries: { action: InstanceAuditAction; target: string; detail?: string }[] = [];

  if (typeof body.lockedByInstance === "boolean" && body.lockedByInstance !== before.lockedByInstance) {
    entries.push({
      action: body.lockedByInstance ? "worker_locked" : "worker_unlocked",
      target,
      detail: body.lockedByInstance
        ? "Kill switch on — this machine takes no work until it is cleared"
        : "Kill switch cleared",
    });
  }

  if (typeof body.enabled === "boolean" && body.enabled !== before.enabled) {
    entries.push({ action: body.enabled ? "worker_enabled" : "worker_disabled", target });
  }

  if (typeof body.name === "string" && body.name.trim() && body.name.trim() !== before.name) {
    // Targets the old name: that is what earlier rows in this log call the machine, and a reader
    // following its history backwards has nothing else to match on
    entries.push({ action: "worker_renamed", target, detail: `Renamed to ${body.name.trim()}` });
  }

  const pollIntervalMs = body.pollIntervalMs;
  // What the worker actually runs under, which is the stored value only once somebody pinned it —
  // otherwise the machine resolves against its own default and the stored copy is inert
  const effective = (before.policyOverrides ?? []).includes("pollIntervalMs")
    ? before.policy?.pollIntervalMs
    : undefined;
  if (typeof pollIntervalMs === "number" && pollIntervalMs !== effective) {
    entries.push({
      action: "worker_poll_interval_changed",
      target,
      detail: `${effective ?? "default"} → ${pollIntervalMs} ms`,
    });
  }

  return entries;
}

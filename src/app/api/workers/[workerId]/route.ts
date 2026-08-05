import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth, withWorker } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { Project } from "@/models/project";
import { assignmentsFor, overriddenWorkerPolicy, toApiWorker, usableRepos } from "@/lib/worker-service";

// Everything a worker document still carries is fleet management: what this machine is called,
// whether it may run, and how often it asks. What the work looks like moved to the project, so
// there is no longer a project-admin path into this route.
const ADMIN_FIELDS = ["enabled", "lockedByInstance", "name"] as const;
const POLICY_FIELDS = ["pollIntervalMs"] as const;

// The worker's own source of current policy and assignments between heartbeats, so it has to
// answer the same question the heartbeat does — otherwise a worker that reported its checkouts
// would never learn which projects they match.
export const GET = withWorker(async (_request, { worker }) => {
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
    assignments: assignmentsFor(usableRepos(worker as never, others as never), projects as never),
  });
});

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// withProjectAdmin cannot be used here — it resolves params.projectId, and this
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
  return NextResponse.json(toApiWorker(updated!));
});

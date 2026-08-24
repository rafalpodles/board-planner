import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth, withWorker } from "@/lib/middleware";
import { stripControlCharacters } from "@/lib/identifiers";
import { Worker } from "@/models/worker";
import { Project } from "@/models/project";
import { assignmentsFor, catalogueFor, offersFor, overriddenWorkerPolicy, ownerReachableProjectIds, toApiWorker, usableRepos } from "@/lib/worker-service";
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
  const [projects, others, reachable] = await Promise.all([
    // Not narrowed to `worker.enabled` any more: the catalogue below has to carry the switched-off
    // projects too, because the screen that renders it is where somebody switches one on. The
    // enabled test still happens, inside assignmentsFor and offersFor, where it decides work.
    Project.find({}).select("_id key name repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    Worker.find({ _id: { $ne: worker._id } }).select(
      "_id name host repos enabled lockedByInstance lastSeenAt createdAt"
    ),
    ownerReachableProjectIds(worker),
  ]);

  return NextResponse.json({
    ...toApiWorker(worker),
    policy: overriddenWorkerPolicy(worker),
    // This is the field the worker actually reads, so the contested-checkout decision has to be
    // applied here and not only on the heartbeat, whose assignments nothing consumes.
    assignments: assignmentsFor(
      usableRepos(worker as never, others as never),
      projects as never,
      reachable
    ),
    // The other half of the same question: what this machine could serve if it had the checkout.
    // Rendered by the app as the projects you can add, so it carries an address to clone and a name
    // to show — never a path, which stays the machine's own business.
    offers: offersFor(
      usableRepos(worker as never, others as never),
      projects as never,
      reachable
    ),
    // Everything this machine's owner can reach, with the state each row needs: what it serves,
    // what was picked, what is switched off, and what cannot be picked for want of a repository.
    catalogue: catalogueFor(
      usableRepos(worker as never, others as never),
      projects as never,
      reachable,
      worker.desiredProjects?.map(String)
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

  // Release only — `owner: null` and nothing else. Registration is the one thing that decides whose
  // machine this is, and it now refuses to re-register somebody else's; without a way to let one
  // go, a machine whose owner has left could never be enrolled again under the same name and host.
  // Assigning an owner from here is deliberately not offered: that would hand the decision to
  // somebody who is not at the machine, which is the step BP-358 removed.
  if ("owner" in body) {
    if (body.owner !== null) {
      return NextResponse.json(
        { error: "owner can only be cleared here — a machine is claimed by enrolling it" },
        { status: 400 }
      );
    }
    update.owner = null;
  }

  for (const field of ADMIN_FIELDS) {
    if (!(field in body)) continue;
    if (field === "name") {
      if (typeof body.name !== "string") {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      // The one other writer of this field besides registration, and the only one an admin
      // controls directly rather than a machine reporting itself — same characters stripped for
      // the same reason: unlike registration this could 400 and be retyped, but stripping matches
      // what the field gets everywhere else rather than adding a third behaviour for it (BP-413).
      // Checked for empty AFTER stripping — a name of nothing but control characters passes a
      // check made against the raw string (they are not whitespace, so `.trim()` alone leaves them)
      // and would otherwise be stored as "".
      const stripped = stripControlCharacters(body.name).trim().slice(0, 120);
      if (!stripped) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      update.name = stripped;
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

  // Populated, like the fleet list is: without it toApiWorker answers `owner: null` for a machine
  // that has one, the console merges that into the row, and its Owner column flashes the red
  // "claims nothing" flag until the next poll corrects it — a false alarm on the very indicator
  // this branch added, raised by the page's most-used control.
  const updated = await Worker.findByIdAndUpdate(workerId, { $set: update }, { new: true }).populate(
    "owner",
    "username fullName"
  );
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
  owner?: unknown;
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

  if (body.owner === null && before.owner) {
    entries.push({
      action: "worker_released",
      target,
      detail: "Owner cleared — it claims nothing until somebody enrols it again",
    });
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

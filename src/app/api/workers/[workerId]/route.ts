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

const ADMIN_FIELDS = ["enabled", "lockedByInstance", "name"] as const;
const POLICY_FIELDS = ["pollIntervalMs"] as const;

export const GET = withWorker(async (_request, { worker }) => {
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  await connectDB();
  const [projects, others, reachable] = await Promise.all([
    Project.find({}).select("_id key name repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    Worker.find({ _id: { $ne: worker._id } }).select(
      "_id name host repos enabled lockedByInstance lastSeenAt createdAt"
    ),
    ownerReachableProjectIds(worker),
  ]);

  return NextResponse.json({
    ...toApiWorker(worker),
    policy: overriddenWorkerPolicy(worker),
    assignments: assignmentsFor(
      usableRepos(worker as never, others as never),
      projects as never,
      reachable
    ),
    offers: offersFor(
      usableRepos(worker as never, others as never),
      projects as never,
      reachable
    ),
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

export const PATCH = withAuth(async (request, { params, user }) => {
  await connectDB();

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

  if (touchedPolicyFields.size > 0) {
    update.policyOverrides = [...new Set([...(worker.policyOverrides ?? []), ...touchedPolicyFields])];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await Worker.findByIdAndUpdate(workerId, { $set: update }, { new: true }).populate(
    "owner",
    "username fullName"
  );
  if (!updated) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }

  for (const entry of auditEntries(body, worker)) {
    void logInstanceAudit({ ...entry, user: String(user._id), actorUsername: user.username });
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
    entries.push({ action: "worker_renamed", target, detail: `Renamed to ${body.name.trim()}` });
  }

  const pollIntervalMs = body.pollIntervalMs;
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

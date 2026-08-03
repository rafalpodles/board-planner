import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth, withWorker, canAdminProject } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { Project } from "@/models/project";
import { collidingAssignment, toApiWorker } from "@/lib/worker-service";
import { logProjectAudit } from "@/lib/projectAudit";

// Instance-admin only: retargeting a worker, renaming it, enabling/disabling or
// locking it are fleet-management acts, not something a project admin governs
const ADMIN_FIELDS = ["assignments", "enabled", "lockedByInstance", "name"] as const;
// Project-admin territory: how the worker behaves once it is already assigned
const POLICY_FIELDS = [
  "autoMerge",
  "baseBranch",
  "pollIntervalMs",
  "taskTimeoutMs",
  "maxDiffLines",
  "maxDiffFiles",
  "model",
  "fallbackModel",
  "reviewModel",
] as const;
const BOOLEAN_POLICY_FIELDS: ReadonlySet<string> = new Set(["autoMerge"]);
const STRING_POLICY_FIELDS: ReadonlySet<string> = new Set([
  "baseBranch",
  "model",
  "fallbackModel",
  "reviewModel",
]);

export const GET = withWorker(async (_request, { worker }) => {
  return NextResponse.json(toApiWorker(worker));
});

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeAssignments(
  value: unknown
): { project: string; proposedPath: string }[] | null {
  if (!Array.isArray(value)) return null;

  const result: { project: string; proposedPath: string }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { project, proposedPath } = entry as Record<string, unknown>;
    if (typeof project !== "string" || !isValidObjectId(project)) return null;
    if (typeof proposedPath !== "string" || !proposedPath.trim()) return null;
    result.push({ project, proposedPath: proposedPath.trim() });
  }
  return result;
}

// withProjectAdmin cannot be used here — it resolves params.projectId, and this
// route carries params.workerId. So this is withAuth, splitting by blast radius
// inside the handler instead of at the wrapper.
export const PATCH = withAuth(async (request, { params, user }) => {
  await connectDB();

  // A machine credential must not be able to retarget a laptop, or clear lockedByInstance on it;
  // that requires an interactive admin session. Keyed on viaMachineCredential, not tokenScoped: an
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

  const isAdmin = user.role === "admin";
  const update: Record<string, unknown> = {};

  for (const field of ADMIN_FIELDS) {
    if (!(field in body)) continue;
    if (!isAdmin) {
      return NextResponse.json({ error: `${field} is instance-admin only` }, { status: 403 });
    }

    if (field === "assignments") {
      const assignments = normalizeAssignments(body.assignments);
      if (!assignments) {
        return NextResponse.json(
          { error: "assignments must be [{ project: <ObjectId>, proposedPath: <non-empty string> }]" },
          { status: 400 }
        );
      }
      // Read every other worker, not just the ones already on these projects: an assignment is a
      // claim on a checkout, and the checkout is what two live workers cannot share.
      const others = await Worker.find({ _id: { $ne: workerId } });
      const collision = collidingAssignment(assignments, others);
      if (collision) {
        return NextResponse.json(
          {
            error:
              `${collision.workerName} already runs ${collision.assignment.proposedPath} for this ` +
              `project; two live workers cannot share a checkout`,
          },
          { status: 409 }
        );
      }
      update.assignments = assignments;
    } else if (field === "enabled" || field === "lockedByInstance") {
      if (typeof body[field] !== "boolean") {
        return NextResponse.json({ error: `${field} must be a boolean` }, { status: 400 });
      }
      update[field] = body[field];
    } else {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      update.name = body.name.trim();
    }
  }

  // Policy is worker-wide, so a project admin must control every project this
  // worker currently serves, not just one — otherwise admining any single
  // assigned project reaches into every other project sharing the worker.
  // Resolved lazily and only once. `[].every(...)` is vacuously true, so an
  // unassigned worker is excluded explicitly rather than falling through it.
  const touchedPolicyFields = new Set<string>();
  let allowedForPolicy: boolean | null = isAdmin ? true : null;
  let verifiedProjectIds = new Set<string>();
  for (const field of POLICY_FIELDS) {
    if (!(field in body)) continue;

    if (allowedForPolicy === null) {
      const projectIds = worker.assignments.map((a) => String(a.project));
      const projects = projectIds.length
        ? await Project.find({ _id: { $in: projectIds } }).select("owner admins")
        : [];
      allowedForPolicy =
        projectIds.length > 0 &&
        projects.length === projectIds.length &&
        projects.every((p) => canAdminProject(user, p));
      if (allowedForPolicy) {
        verifiedProjectIds = new Set(projects.map((p) => String(p._id)));
      }
    }
    if (!allowedForPolicy) {
      return NextResponse.json(
        { error: `${field} requires admin of every project this worker is assigned to` },
        { status: 403 }
      );
    }

    if (BOOLEAN_POLICY_FIELDS.has(field)) {
      if (typeof body[field] !== "boolean") {
        return NextResponse.json({ error: `${field} must be a boolean` }, { status: 400 });
      }
      update[`policy.${field}`] = body[field];
    } else if (STRING_POLICY_FIELDS.has(field)) {
      if (typeof body[field] !== "string" || !body[field].trim()) {
        return NextResponse.json({ error: `${field} must be a non-empty string` }, { status: 400 });
      }
      update[`policy.${field}`] = body[field].trim();
    } else {
      if (!isPositiveInt(body[field])) {
        return NextResponse.json({ error: `${field} must be a positive integer` }, { status: 400 });
      }
      update[`policy.${field}`] = body[field];
    }
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

  const detail = Object.keys(update).join(", ");
  for (const assignment of worker.assignments) {
    await logProjectAudit(String(assignment.project), String(user._id), "worker_updated", detail);
  }

  const apiWorker = toApiWorker(updated!);
  if (!isAdmin) {
    // Filtered against verifiedProjectIds rather than trusting the response is
    // already scoped: assignments can change between the read above and this
    // write, and a project admin must never see a project added in that window
    apiWorker.assignments = apiWorker.assignments.filter((a) => verifiedProjectIds.has(a.project));
  }
  return NextResponse.json(apiWorker);
});

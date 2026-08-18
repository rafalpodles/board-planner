import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { findPendingByUserCode, formatUserCode } from "@/lib/device-enrolment";

// What the confirmation page renders: which machine is asking, which projects this person can give
// it, and whether this machine already has a worker — the case that silently killed a running one.
//
// withAuth, not withAdmin (BP-358): a machine now runs only its owner's own work inside permissions
// that person already holds, so admitting one is no longer an instance-level decision. The list is
// narrowed to what the person confirming can reach, which is also exactly what the machine will be
// able to reach afterwards.
export const GET = withAuth(async (_request, { params, user }) => {
  await connectDB();
  const { userCode } = await params;

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }

  const enrolment = await findPendingByUserCode(userCode);
  if (!enrolment) {
    return NextResponse.json({ error: "This code is not valid any more" }, { status: 404 });
  }

  const reachable = await accessibleProjectIds(user);
  // The same rule PUT /api/projects/:id applies to `worker`: committing a project to machines is
  // instance-admin, not project-admin. Answered once rather than per project, because it is not a
  // per-project question.
  const canEnable = user.role === "admin";
  const projects = await Project.find(reachable === null ? {} : { _id: { $in: reachable } })
    .select("_id name key repositoryUrl worker")
    .lean();
  const existing = await Worker.findOne({
    name: enrolment.machineName,
    host: enrolment.machineHost,
  }).select("_id name host lastSeenAt");

  return NextResponse.json({
    userCode: formatUserCode(enrolment.userCode),
    machineName: enrolment.machineName,
    machineHost: enrolment.machineHost,
    status: enrolment.status,
    expiresAt: enrolment.expiresAt.toISOString(),
    // A project with no repository cannot be served, so it is offered as unavailable rather than
    // hidden — "where is my project" is a worse question than "why is it greyed out"
    projects: projects.map((p) => ({
      _id: String(p._id),
      name: p.name,
      key: p.key,
      repositoryUrl: p.repositoryUrl ?? "",
      workersEnabled: !!p.worker?.enabled,
      // Whether confirming here can also turn machines on for that project. Rendered rather than
      // discovered afterwards: a project left switched off takes the machine and then runs
      // nothing, which is the one outcome nobody can diagnose from the machine's own logs.
      canEnable,
    })),
    existingWorker: existing
      ? {
          _id: String(existing._id),
          name: existing.name,
          host: existing.host,
          lastSeenAt: existing.lastSeenAt ? new Date(existing.lastSeenAt).toISOString() : null,
        }
      : null,
  });
});

import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { findPendingByUserCode, formatUserCode } from "@/lib/device-enrolment";

// What the approval page renders: which machine is asking, which projects this operator can give
// it, and whether this machine already has a worker — the case that silently killed a running one.
export const GET = withAdmin(async (_request, { params, user }) => {
  await connectDB();
  const { userCode } = await params;

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  const enrolment = await findPendingByUserCode(userCode);
  if (!enrolment) {
    return NextResponse.json({ error: "This code is not valid any more" }, { status: 404 });
  }

  const projects = await Project.find({}).select("_id name key repositoryUrl worker").lean();
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

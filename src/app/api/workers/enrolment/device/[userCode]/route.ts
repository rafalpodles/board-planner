import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { findPendingByUserCode, formatUserCode } from "@/lib/device-enrolment";
import { projectRepositoryUrl } from "@/lib/repository";

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
  const canEnable = user.role === "admin";
  const projects = await Project.find(reachable === null ? {} : { _id: { $in: reachable } })
    .select("_id name key repositoryUrl githubRepo gitlabRepo gitlabHost worker")
    .lean();
  const existing = await Worker.findOne({
    name: enrolment.machineName,
    host: enrolment.machineHost,
  }).select("_id owner");
  const existingWorker = existing
    ? { mine: String(existing.owner ?? "") === String(user._id) || !existing.owner }
    : null;

  return NextResponse.json({
    userCode: formatUserCode(enrolment.userCode),
    machineName: enrolment.machineName,
    machineHost: enrolment.machineHost,
    status: enrolment.status,
    expiresAt: enrolment.expiresAt.toISOString(),
    projects: projects.map((p) => ({
      _id: String(p._id),
      name: p.name,
      key: p.key,
      repositoryUrl: projectRepositoryUrl(p),
      workersEnabled: !!p.worker?.enabled,
      canEnable,
    })),
    existingWorker,
  });
});

import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { Project } from "@/models/project";
import { DeviceEnrolment } from "@/models/deviceEnrolment";
import { registerWorker, WorkerAlreadyOwned } from "@/lib/worker-service";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { denyDeviceEnrolment, findPendingByUserCode } from "@/lib/device-enrolment";
import { projectRepositoryUrl } from "@/lib/repository";

export const POST = withAuth(async (request, { params, user }) => {
  await connectDB();
  const { userCode } = await params;

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  if (body.deny === true) {
    const denied = await denyDeviceEnrolment(userCode);
    return denied
      ? NextResponse.json({ state: "denied" })
      : NextResponse.json({ error: "This code is not valid any more" }, { status: 404 });
  }

  const enrolment = await findPendingByUserCode(userCode);
  if (!enrolment || enrolment.status !== "pending") {
    return NextResponse.json({ error: "This code is not valid any more" }, { status: 404 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!isValidObjectId(projectId)) {
    return NextResponse.json({ error: "Choose a project" }, { status: 400 });
  }

  if (!(await check(user, projectId, "access"))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const project = await Project.findById(projectId).select("_id key repositoryUrl githubRepo gitlabRepo gitlabHost worker");
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  if (!projectRepositoryUrl(project)) {
    return NextResponse.json(
      { error: "That project does not name a repository yet — set one under Integrations first" },
      { status: 400 }
    );
  }

  const key = project.key || String(project._id);
  const mayEnable = user.role === "admin";
  if (mayEnable && !project.worker?.enabled) {
    await Project.updateOne({ _id: project._id }, { $set: { "worker.enabled": true } });
    void logInstanceAudit({
      action: "project_workers_enabled",
      target: key,
      user: String(user._id),
      actorUsername: user.username,
      detail: `Enrolling ${enrolment.machineName}`,
    });
  }

  let registered;
  try {
    registered = await registerWorker({
      name: enrolment.machineName,
      host: enrolment.machineHost,
      platform: typeof body.platform === "string" ? body.platform : "",
      version: "",
      owner: user.fullName || user.username,
      ownerId: String(user._id),
    });
  } catch (error) {
    if (error instanceof WorkerAlreadyOwned) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  const { worker, credential } = registered;

  void logInstanceAudit({
    action: "enrolment_token_spent",
    target: worker.name,
    user: String(user._id),
    actorUsername: user.username,
    detail: `Enrolled for ${key} on ${enrolment.machineHost}`,
  });

  await DeviceEnrolment.updateOne(
    { _id: enrolment._id, status: "pending" },
    {
      $set: {
        status: "approved",
        enrolledBy: user._id,
        project: project._id,
        worker: worker._id,
        credential,
      },
    }
  );

  return NextResponse.json({
    state: "approved",
    workerId: String(worker._id),
    workersEnabled: mayEnable || !!project.worker?.enabled,
  });
});

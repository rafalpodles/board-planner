import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { DeviceEnrolment } from "@/models/deviceEnrolment";
import { registerWorker } from "@/lib/worker-service";
import {
  denyDeviceEnrolment,
  findPendingByUserCode,
  isWorkerPreset,
  PRESET_POLICY,
} from "@/lib/device-enrolment";
import { projectRepositoryUrl } from "@/lib/repository";

// The approval itself. withAdmin plus the viaMachineCredential refusal, exactly as minting an
// enrolment token is: handing a machine a credential is a thing a person does at a keyboard, and a
// token that could do it would hand back the power this flow exists to remove.
export const POST = withAdmin(async (request, { params, user }) => {
  await connectDB();
  const { userCode } = await params;

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
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
  const preset = body.preset;
  if (!isWorkerPreset(preset)) {
    return NextResponse.json({ error: "Choose how much autonomy to give it" }, { status: 400 });
  }

  const project = await Project.findById(projectId).select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker");
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // The machine is told which repository to fetch, so a project that names none has nothing to
  // give it. Caught here rather than as an unreadable binding error after the first task.
  if (!projectRepositoryUrl(project)) {
    return NextResponse.json(
      { error: "That project does not name a repository yet — set one under Integrations first" },
      { status: 400 }
    );
  }

  const policy = PRESET_POLICY[preset];
  await Project.updateOne(
    { _id: project._id },
    {
      $set: {
        "worker.enabled": true,
        "worker.policy.reviewGate": policy.reviewGate,
        "worker.policy.autoMerge": policy.autoMerge,
        "worker.policyOverrides": [
          ...new Set([...(project.worker?.policyOverrides ?? []), "reviewGate", "autoMerge"]),
        ],
      },
    }
  );

  // Registration mints the credential and the machine's identity. Re-registering the same
  // name+host reclaims the existing worker rather than leaving a ghost holding the assignments.
  const { worker, credential } = await registerWorker({
    name: enrolment.machineName,
    host: enrolment.machineHost,
    platform: typeof body.platform === "string" ? body.platform : "",
    version: "",
    owner: user.fullName || user.username,
  });

  await DeviceEnrolment.updateOne(
    { _id: enrolment._id, status: "pending" },
    {
      $set: {
        status: "approved",
        approvedBy: user._id,
        project: project._id,
        preset,
        worker: worker._id,
        credential,
      },
    }
  );

  return NextResponse.json({ state: "approved", workerId: String(worker._id) });
});

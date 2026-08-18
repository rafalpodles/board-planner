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

// The confirmation itself, and the whole of enrolment (BP-358): there is no admin approval step
// behind it any more.
//
// The step was right while a machine took work assigned to a project-wide nominee — anyone's work —
// so admitting a machine to the instance was an instance-level decision and an admin was the right
// gate. A machine now runs only its owner's own work, on its owner's own hardware, inside
// permissions that person already holds; the approval signed off on something already permitted.
//
// withAuth keeps the two things that did not stop mattering: this is a person at a keyboard, not a
// token read off the same disk the agent can read, and the person is the owner. An instance admin
// keeps the fleet console and the kill switch, and stops being a required step.
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

  // The project is what the machine is told to clone, so naming one the confirming person cannot
  // reach would hand a repository address to somebody with no claim on it. The machine's own reach
  // is resolved from its owner on every call and would refuse the project anyway; refusing here is
  // what stops the address travelling in the first place.
  if (!(await check(user, projectId, "access"))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const project = await Project.findById(projectId).select("_id key repositoryUrl githubRepo gitlabRepo gitlabHost worker");
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // The machine is told which repository to fetch, so a project that names none has nothing to
  // give it. Caught here rather than as an unreadable binding error after the first task.
  if (!projectRepositoryUrl(project)) {
    return NextResponse.json(
      { error: "That project does not name a repository yet — set one under Integrations first" },
      { status: 400 }
    );
  }

  // Committing a project to machines stays instance-admin, exactly as PUT /api/projects/:id has it:
  // it commits somebody's machine to running agent-written code, which is not a project admin's
  // call to make and certainly not a member's. Enrolling a laptop does not make that decision for
  // the project. Done here as well as from the settings screen because this is the path people
  // actually take, and a log that misses the primary route implies a completeness it does not have.
  const key = project.key || String(project._id);
  const mayEnable = user.role === "admin";
  if (mayEnable && !project.worker?.enabled) {
    await Project.updateOne({ _id: project._id }, { $set: { "worker.enabled": true } });
    void logInstanceAudit({
      action: "project_workers_enabled",
      target: key,
      user: String(user._id),
      detail: `Enrolling ${enrolment.machineName}`,
    });
  }

  // Registration mints the credential and the machine's identity. Re-registering the same
  // name+host reclaims the existing worker rather than leaving a ghost holding the assignments —
  // but only when it is already yours. Somebody else's machine is refused: the enrolment-start
  // route is unauthenticated and takes any name and host, so without this, guessing a colleague's
  // hostname would mint a new credential for their machine, stop the process running there and
  // inherit its reported checkouts.
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

  // The device flow's equivalent of spending an enrolment token: a machine gains a credential.
  // The token path records that, and an operator reading the log should not have to know which
  // of two enrolment routes was used to find out a machine joined.
  void logInstanceAudit({
    action: "enrolment_token_spent",
    target: worker.name,
    user: String(user._id),
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

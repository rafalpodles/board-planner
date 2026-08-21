import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { catalogueFor, ownerReachableProjectIds, usableRepos } from "@/lib/worker-service";
import { logInstanceAudit } from "@/lib/instanceAudit";

// The screen where somebody says which projects a machine should work on, and the one place that
// choice is written down. It is a browser screen and not a pane in the app for a reason that is
// not cosmetic: ticking a project may have to switch workers on for it, and that is an instance
// admin acting in an interactive session — something the app, which holds no board credential and
// carries only the machine's, can never be.
//
// The selection is stored rather than derived. What a machine HAS is its reported checkouts; what
// somebody WANTS it to have is a different question, and the gap between the two is the work the
// app then does. Nothing here touches a disk: this route records intent.

async function loadOwnedWorker(workerId: string, userId: string, isAdmin: boolean) {
  if (!isValidObjectId(workerId)) return null;
  const worker = await Worker.findById(workerId).select(
    "_id name host owner repos desiredProjects"
  );
  if (!worker) return null;
  // The owner's machine, or an instance admin's fleet console. A colleague who guessed the id
  // gets the same answer as somebody who guessed a wrong one.
  const mine = String(worker.owner ?? "") === String(userId);
  return mine || isAdmin ? worker : null;
}

export const GET = withAuth(async (_request, { params, user }) => {
  await connectDB();
  const { workerId } = await params;

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }

  const worker = await loadOwnedWorker(workerId, String(user._id), user.role === "admin");
  if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });

  // The machine's reach, not the caller's: an instance admin looking at somebody else's laptop
  // must see what that laptop can be given, not what they themselves can reach.
  const [projects, others, reachable] = await Promise.all([
    Project.find({}).select("_id key name repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    Worker.find({ _id: { $ne: worker._id } }).select("_id name host repos enabled lockedByInstance lastSeenAt createdAt"),
    ownerReachableProjectIds(worker),
  ]);

  return NextResponse.json({
    worker: { _id: String(worker._id), name: worker.name, host: worker.host },
    // Whether this person can switch a project on while they are here, which is what the screen
    // needs to know before it offers a switched-off project as tickable
    canEnableWorkers: user.role === "admin",
    catalogue: catalogueFor(
      usableRepos(worker as never, others as never),
      projects as never,
      reachable,
      worker.desiredProjects?.map(String)
    ),
  });
});

export const PUT = withAuth(async (request, { params, user }) => {
  await connectDB();
  const { workerId } = await params;

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }

  const worker = await loadOwnedWorker(workerId, String(user._id), user.role === "admin");
  if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });

  const body: unknown = await request.json().catch(() => ({}));
  const asked = Array.isArray((body as { projects?: unknown })?.projects)
    ? ((body as { projects: unknown[] }).projects.filter((p) => typeof p === "string") as string[])
    : null;
  if (!asked) {
    return NextResponse.json({ error: "projects must be an array" }, { status: 400 });
  }

  // Both reaches have to hold. The caller's, because handing a repository address to somebody with
  // no claim on the project is the leak the enrolment screen already refuses; and the machine
  // owner's, because a project outside it would be recorded as wanted and then refused on every
  // claim, which reads as a broken machine rather than a permission it never had.
  const [callerReach, ownerReach] = await Promise.all([
    accessibleProjectIds(user),
    ownerReachableProjectIds(worker),
  ]);
  const within = (reach: string[] | null, id: string) => reach === null || reach.includes(id);

  const wanted = [...new Set(asked)].filter(
    (id) => isValidObjectId(id) && within(callerReach, id) && within(ownerReach, id)
  );

  const chosen = await Project.find({ _id: { $in: wanted } }).select("_id key worker").lean();

  // Ticking a project that nobody has committed to machines is the point of this screen — but the
  // commitment itself is still instance-admin, and still audited, exactly as it is on the project's
  // own settings page. A member who ticks one records the wish; the switch stays off and the reply
  // says which ones, so the screen can say it rather than leaving a machine idle with no reason.
  const leftDisabled: string[] = [];
  for (const project of chosen) {
    if (project.worker?.enabled) continue;
    if (user.role !== "admin") {
      leftDisabled.push(project.key || String(project._id));
      continue;
    }
    await Project.updateOne({ _id: project._id }, { $set: { "worker.enabled": true } });
    void logInstanceAudit({
      action: "project_workers_enabled",
      target: project.key || String(project._id),
      user: String(user._id),
      detail: `Picked for ${worker.name}`,
    });
  }

  await Worker.updateOne({ _id: worker._id }, { $set: { desiredProjects: wanted } });

  return NextResponse.json({
    ok: true,
    projects: wanted,
    // Named rather than counted: "two projects will not run" is not something anybody can act on
    leftDisabled,
    // What the caller asked for and did not get, for the same reason
    refused: asked.filter((id) => !wanted.includes(id)),
  });
});

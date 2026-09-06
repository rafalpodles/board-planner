import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { catalogueFor, ownerReachableProjectIds, usableRepos } from "@/lib/worker-service";
import { logInstanceAudit } from "@/lib/instanceAudit";

async function loadOwnedWorker(workerId: string, userId: string, isAdmin: boolean) {
  if (!isValidObjectId(workerId)) return null;
  const worker = await Worker.findById(workerId).select(
    "_id name host owner repos desiredProjects"
  );
  if (!worker) return null;
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

  const [projects, others, reachable] = await Promise.all([
    Project.find({}).select("_id key name repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    Worker.find({ _id: { $ne: worker._id } }).select("_id name host repos enabled lockedByInstance lastSeenAt createdAt"),
    ownerReachableProjectIds(worker),
  ]);

  return NextResponse.json({
    worker: { _id: String(worker._id), name: worker.name, host: worker.host },
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

  const [callerReach, ownerReach] = await Promise.all([
    accessibleProjectIds(user),
    ownerReachableProjectIds(worker),
  ]);
  const within = (reach: string[] | null, id: string) => reach === null || reach.includes(id);

  const wanted = [...new Set(asked)].filter(
    (id) => isValidObjectId(id) && within(callerReach, id) && within(ownerReach, id)
  );

  const chosen = await Project.find({ _id: { $in: wanted } }).select("_id key worker").lean();

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
      actorUsername: user.username,
      detail: `Picked for ${worker.name}`,
    });
  }

  await Worker.updateOne({ _id: worker._id }, { $set: { desiredProjects: wanted } });

  return NextResponse.json({
    ok: true,
    projects: wanted,
    leftDisabled,
    refused: asked.filter((id) => !wanted.includes(id)),
  });
});

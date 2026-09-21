import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { getProjectColumns } from "@/lib/columns";
import { projectRepositoryUrl } from "@/lib/repository";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { Grant } from "@/models/grant";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { Worker } from "@/models/worker";
import { machineStateFor } from "@/lib/worker-service";
import type { ApiHandoverReadiness } from "@/types";

/**
 * What the task screen needs to say why a hand-over will not run, beyond the task itself: the
 * board's own readiness, who owns it (by display name only — the people a member can ask), and
 * whether the READER's own machines serve this board's repository. Never anyone else's machine.
 */
export const GET = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const [project, grants, workers, canAdmin] = await Promise.all([
    Project.findById(projectId, "repositoryUrl githubRepo gitlabRepo worker columns").lean(),
    Grant.find({ objectType: "project", object: projectId, relation: "owner" })
      .select("subject")
      .lean(),
    Worker.find(
      { owner: user._id },
      "enabled lastSeenAt repos preflight command commandIssuedAt commandAckedAt"
    ).lean(),
    check(user, projectId, "admin"),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const owners = await User.find(
    { _id: { $in: grants.map((g) => g.subject) }, kind: { $ne: "machine" } },
    "username fullName"
  )
    .sort({ username: 1 })
    .lean();

  const body: ApiHandoverReadiness = {
    owners: owners.map((o) => o.fullName || o.username),
    canAdmin,
    repositoryUrl: projectRepositoryUrl(project),
    workerEnabled: !!project.worker?.enabled,
    lockedByInstance: isWorkerLockedByInstance(project.worker),
    columns: getProjectColumns(project).map((c) => ({ role: c.role })),
    machine: machineStateFor(workers, project),
  };
  return NextResponse.json(body);
});

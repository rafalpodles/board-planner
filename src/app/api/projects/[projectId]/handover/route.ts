import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Grant } from "@/models/grant";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { Worker } from "@/models/worker";
import { machineStateFor } from "@/lib/worker-service";

/**
 * What the task screen needs to say why a hand-over will not run, beyond the task itself: who owns
 * the board (the people who can fix a project-level gap), and whether the READER's own machines
 * serve this board's repository. Never anyone else's machine — a colleague's is only ever
 * "waiting for their machine", which needs no answer from here.
 */
export const GET = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const [project, grants, workers] = await Promise.all([
    Project.findById(projectId, "repositoryUrl githubRepo gitlabRepo").lean(),
    Grant.find({ objectType: "project", object: projectId, relation: "owner" })
      .select("subject")
      .lean(),
    Worker.find(
      { owner: user._id },
      "enabled lastSeenAt repos preflight command commandIssuedAt commandAckedAt"
    ).lean(),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const owners = await User.find(
    { _id: { $in: grants.map((g) => g.subject) }, kind: { $ne: "machine" } },
    "username fullName"
  )
    .sort({ username: 1 })
    .lean();

  return NextResponse.json({
    owners: owners.map((o) => ({ username: o.username, fullName: o.fullName })),
    ...machineStateFor(workers, project),
  });
});

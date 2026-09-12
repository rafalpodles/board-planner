import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { syncGithubPullRequests } from "@/lib/github-sync";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  // Optional, and the task detail's Refresh is the only caller that sends it: the sync still reads
  // every pull request, but only the named task may be moved out of review by it.
  const body = await request.json().catch(() => ({}));
  const transitionOnly =
    typeof body?.taskNumber === "number" && Number.isInteger(body.taskNumber)
      ? body.taskNumber
      : undefined;

  const project = await Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The person asking is what earns the auto-transition: a background tick passes null and moves
  // nothing, because a column change with an invented author is a history row nobody can explain.
  const result = await syncGithubPullRequests(project, String(user._id), transitionOnly);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { ok: _ok, ...counts } = result;
  return NextResponse.json({ synced: true, ...counts });
});

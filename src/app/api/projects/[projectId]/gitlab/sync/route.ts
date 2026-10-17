import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { syncGitlabMergeRequests } from "@/lib/gitlab-sync";

export const POST = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await db.Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const result = await syncGitlabMergeRequests(db, project, String(user._id));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const { ok: _ok, ...counts } = result;
  return NextResponse.json({ synced: true, ...counts });
});

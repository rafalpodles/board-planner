import { NextResponse } from "next/server";
import { withProjectOwner } from "@/lib/middleware";
import { exportFilename, gzipLinesResponse } from "@/lib/organisation-export-response";
import { projectExport } from "@/lib/project-export";

export const GET = withProjectOwner(async (request, { user, params, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }
  const { projectId } = await params;
  const project = await db.Project.findById(projectId).select("key").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (new URL(request.url).searchParams.get("check") === "1") return new NextResponse(null, { status: 204 });

  // Before the first byte, and not best effort: a download abandoned near its end has still carried the data away
  await db.ProjectAuditLog.create({ project: project._id, user: user._id, action: "project_exported", detail: "" });
  return gzipLinesResponse(projectExport(db, project._id), exportFilename(project.key.toLowerCase(), "project"));
});
